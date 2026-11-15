package gpscandidate

// Experimental storage for the gated candidate; no vehicle transport here.
import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"
)

type RedisCommand func(context.Context, ...string) (any, error)
type JournalStore struct {
	command RedisCommand
	prefix  string
	diagnostic bool
}

var commandNoncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var hexScope = regexp.MustCompile(`^[a-f0-9]{64}$`)
var hexID = regexp.MustCompile(`^[a-f0-9]{32}$`)

// scope must be an account+vehicle digest computed by an authenticated caller.
// Never pass a VIN, subject, credential or user-selected Redis key.
func NewJournalStore(command RedisCommand, scope string) (*JournalStore, error) {
	if command == nil || !hexScope.MatchString(scope) {
		return nil, errors.New("invalid store scope")
	}
	return &JournalStore{command: command, prefix: "tesla-voice:gps-candidate:v1:{" + scope + "}:"}, nil
}

// NewDiagnosticJournalStore shares the same per-vehicle serialization guard as
// the GPS candidate, but uses a separate expiring namespace for two-phase
// diagnostic sessions. The journal itself binds each session to an account.
func NewDiagnosticJournalStore(command RedisCommand, vehicleScope string) (*JournalStore, error) {
	store, err := NewJournalStore(command, vehicleScope)
	if err != nil {
		return nil, err
	}
	store.prefix = "tesla-voice:gps-diagnostic:v1:{" + vehicleScope + "}:"
	store.diagnostic = true
	return store, nil
}
func (s *JournalStore) key(id string) (string, error) {
	if !hexID.MatchString(id) {
		return "", errors.New("invalid route id")
	}
	return s.prefix + id, nil
}

const createScript = `if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); return 1`
const casScript = `if redis.call('GET',KEYS[2])~=ARGV[3] or redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`
const createDiagnosticScript = `if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[3]); redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); return 1`
const casDiagnosticScript = `if redis.call('GET',KEYS[2])~=ARGV[3] or redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[4]); return 1`

// Create reserves this experimental scope and permanently records the journal in
// one Lua execution. No TTL, expired-lease recovery, guard deletion or force reset.
// This guard does NOT replace the existing production per-vehicle command guard.
func (s *JournalStore) Create(ctx context.Context, j Journal) error {
	if err := validate(j); err != nil {
		return err
	}
	if j.Version != 0 {
		return errors.New("initial journal version")
	}
	for _, step := range j.Steps {
		if step.State != Pending {
			return errors.New("initial journal state")
		}
	}
	key, err := s.key(j.RouteID)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	var value any
	if s.diagnostic {
		if j.AccountScope == "" || j.ExpiresAtMS <= time.Now().UnixMilli() || j.ExpiresAtMS > time.Now().Add(30*time.Minute).UnixMilli() {
			return errors.New("invalid diagnostic expiry")
		}
		value, err = s.command(ctx, "EVAL", createDiagnosticScript, "2", key, s.prefix+"guard", string(raw), j.RouteID, strconv.FormatInt(j.ExpiresAtMS-time.Now().UnixMilli(), 10))
	} else {
		if j.AccountScope != "" || j.ExpiresAtMS != 0 {
			return errors.New("diagnostic journal requires expiring store")
		}
		value, err = s.command(ctx, "EVAL", createScript, "2", key, s.prefix+"guard", string(raw), j.RouteID)
	}
	if err != nil {
		return errors.New("journal store unavailable")
	}
	if value != int64(1) {
		released, e := s.ReconcileGuard(ctx)
		if e != nil || !released {
			return errors.New("route already reserved")
		}
		if s.diagnostic {
			remaining := j.ExpiresAtMS - time.Now().UnixMilli()
			if remaining <= 0 {
				return errors.New("diagnostic session expired")
			}
			value, err = s.command(ctx, "EVAL", createDiagnosticScript, "2", key, s.prefix+"guard", string(raw), j.RouteID, strconv.FormatInt(remaining, 10))
		} else {
			value, err = s.command(ctx, "EVAL", createScript, "2", key, s.prefix+"guard", string(raw), j.RouteID)
		}
		if err != nil || value != int64(1) {
			return errors.New("route already reserved")
		}
	}
	return nil
}
func (s *JournalStore) Load(ctx context.Context, id string) (Journal, error) {
	key, err := s.key(id)
	if err != nil {
		return Journal{}, err
	}
	value, err := s.command(ctx, "GET", key)
	if err != nil {
		return Journal{}, errors.New("journal store unavailable")
	}
	raw, ok := value.(string)
	if !ok || len(raw) > 32768 {
		return Journal{}, errors.New("journal missing or invalid")
	}
	var j Journal
	if json.Unmarshal([]byte(raw), &j) != nil || j.RouteID != id {
		return Journal{}, errors.New("journal invalid")
	}
	if err := validate(j); err != nil {
		return Journal{}, err
	}
	return j, nil
}

// SaveProposal atomically fences a transition against the exact previous record
// and retained route guard. A storage error means NOT authorized to dispatch.
func (s *JournalStore) SaveProposal(ctx context.Context, before, after Journal) error {
	if err := validate(before); err != nil {
		return err
	}
	if err := validate(after); err != nil {
		return err
	}
	if before.CommandNonce != after.CommandNonce || before.RouteID != after.RouteID || after.Version != before.Version+1 || len(before.Steps) != len(after.Steps) {
		return errors.New("invalid proposal")
	}
	if before.AccountScope != after.AccountScope || before.ExpiresAtMS != after.ExpiresAtMS {
		return errors.New("diagnostic scope changed")
	}
	changed := 0
	for i, b := range before.Steps {
		a := after.Steps[i]
		if a.PayloadHash != b.PayloadHash {
			return errors.New("payload changed")
		}
		if a == b {
			continue
		}
		changed++
		if b.State == Pending {
			if a.State != InFlight || b.ClaimID != "" || !hexID.MatchString(a.ClaimID) {
				return errors.New("invalid claim")
			}
		} else if b.State == InFlight {
			if a.ClaimID != b.ClaimID || (a.State != Accepted && a.State != Rejected && a.State != Unknown) {
				return errors.New("invalid receipt")
			}
		} else {
			return errors.New("terminal receipt immutable")
		}
	}
	if changed != 1 {
		return errors.New("proposal must change exactly one step")
	}
	key, err := s.key(before.RouteID)
	if err != nil {
		return err
	}
	oldRaw, _ := json.Marshal(before)
	newRaw, _ := json.Marshal(after)
	var value any
	if s.diagnostic {
		remaining := before.ExpiresAtMS - time.Now().UnixMilli()
		if remaining <= 0 {
			return errors.New("diagnostic session expired")
		}
		value, err = s.command(ctx, "EVAL", casDiagnosticScript, "2", key, s.prefix+"guard", string(oldRaw), string(newRaw), before.RouteID, strconv.FormatInt(remaining, 10))
	} else {
		value, err = s.command(ctx, "EVAL", casScript, "2", key, s.prefix+"guard", string(oldRaw), string(newRaw), before.RouteID)
	}
	if err != nil {
		return errors.New("journal store unavailable")
	}
	if value != int64(1) {
		return errors.New("stale or unowned journal")
	}
	return nil
}

// ReconcileGuard never expires evidence. It releases only an exact retained
// journal: all API replies accepted, or a nonce-matched immutable proxy receipt
// certifying no command dispatch and no earlier accepted step. Legacy fixtures
// without a command nonce remain blocked. Journal and receipt are never deleted.
func (s *JournalStore) ReconcileGuard(ctx context.Context) (bool, error) {
	held, err := s.command(ctx, "GET", s.prefix+"guard")
	if err != nil {
		return false, errors.New("journal store unavailable")
	}
	id, ok := held.(string)
	if !ok || !hexID.MatchString(id) {
		return false, nil
	}
	j, err := s.Load(ctx, id)
	if err != nil {
		return false, err
	}
	if !commandNoncePattern.MatchString(j.CommandNonce) {
		return false, nil
	}
	summary, err := Summarize(j)
	if err != nil {
		return false, err
	}
	proven := summary.AllAPIAccepted
	if !proven && summary.AcceptedSteps == 0 {
		value, e := s.command(ctx, "GET", "tesla-voice:v1:command-proxy-receipt:"+j.CommandNonce)
		if e != nil {
			return false, errors.New("receipt unavailable")
		}
		if raw, ok := value.(string); ok && len(raw) <= 4096 {
			var receipt struct {
				Version            int
				Nonce, State       string
				DefinitiveNoEffect bool `json:"definitive_no_effect"`
			}
			if json.Unmarshal([]byte(raw), &receipt) == nil && receipt.Version == 1 && receipt.Nonce == j.CommandNonce && receipt.State == "failed" && receipt.DefinitiveNoEffect {
				proven = true
			}
		}
	}
	if !proven {
		return false, nil
	}
	raw, _ := json.Marshal(j)
	key, _ := s.key(id)
	const release = `if redis.call('GET',KEYS[2])==ARGV[2] and redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[2]) else return 0 end`
	value, err := s.command(ctx, "EVAL", release, "2", key, s.prefix+"guard", string(raw), id)
	if err != nil {
		return false, errors.New("journal store unavailable")
	}
	return value == int64(1), nil
}
