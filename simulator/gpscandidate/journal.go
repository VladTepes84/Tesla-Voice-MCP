package gpscandidate

// Journal transitions do not authorize vehicle commands. The caller MUST persist
// each claim atomically before send and retain uncertain evidence.
import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

type StepState string

const (
	Pending  StepState = "pending"
	InFlight StepState = "in_flight"
	Accepted StepState = "accepted"
	Rejected StepState = "rejected"
	Unknown  StepState = "unknown"
)

type Step struct {
	PayloadHash string
	State       StepState
	ClaimID     string
}

type Journal struct {
	CommandNonce string `json:",omitempty"`
	AccountScope string `json:",omitempty"`
	ExpiresAtMS  int64  `json:",omitempty"`
	RouteID      string
	Version      uint64
	Steps        []Step
}

// Summary distinguishes API acceptance from actual display/route completion.
type Summary struct {
	AcceptedSteps        int
	TotalSteps           int
	Partial              bool
	Blocked              bool
	AllAPIAccepted       bool
	VehicleRouteVerified bool
	RetryAllowed         bool
}

func NewJournal(points []Point) (Journal, error) {
	payloads, err := EncodeRoute(points)
	if err != nil {
		return Journal{}, err
	}
	id, err := randomID()
	if err != nil {
		return Journal{}, err
	}
	j := Journal{RouteID: id, Steps: make([]Step, len(payloads))}
	for i, payload := range payloads {
		sum := sha256.Sum256(payload)
		j.Steps[i] = Step{PayloadHash: hex.EncodeToString(sum[:]), State: Pending}
	}
	return j, nil
}

// NewDiagnosticJournal records only hashes for a two-step, user-gated GPS
// diagnostic. Coordinates are never persisted in the journal. The session is
// bound to an authenticated account scope and has an absolute expiry.
func NewDiagnosticJournal(points []Point, sessionID, accountScope, commandNonce string, expiresAtMS int64) (Journal, error) {
	if len(points) != 2 || !hexID.MatchString(sessionID) || !hexScope.MatchString(accountScope) || expiresAtMS <= 0 || !commandNoncePattern.MatchString(commandNonce) {
		return Journal{}, errors.New("invalid diagnostic session")
	}
	j, err := NewJournal(points)
	if err != nil {
		return Journal{}, err
	}
	j.RouteID = sessionID
	j.AccountScope = accountScope
	j.ExpiresAtMS = expiresAtMS
	j.CommandNonce = commandNonce
	return j, nil
}

func randomID() (string, error) {
	var b [16]byte
	_, err := rand.Read(b[:])
	return hex.EncodeToString(b[:]), err
}
func clone(j Journal) Journal { j.Steps = append([]Step(nil), j.Steps...); return j }

// validate rejects impossible orderings from malformed journals. A repeated point
// has a repeated payload hash but is still a separate indexed operation.
func validate(j Journal) error {
	if j.CommandNonce != "" && !commandNoncePattern.MatchString(j.CommandNonce) {
		return errors.New("invalid journal nonce")
	}
	if j.AccountScope != "" && !hexScope.MatchString(j.AccountScope) || j.ExpiresAtMS != 0 && j.ExpiresAtMS < 1 || (j.AccountScope == "") != (j.ExpiresAtMS == 0) {
		return errors.New("invalid journal scope")
	}
	if len(j.RouteID) != 32 || len(j.Steps) < 2 || len(j.Steps) > 16 {
		return errors.New("invalid journal")
	}
	tail := false
	for _, s := range j.Steps {
		if len(s.PayloadHash) != 64 {
			return errors.New("invalid journal")
		}
		if _, err := hex.DecodeString(s.PayloadHash); err != nil {
			return errors.New("invalid journal")
		}
		switch s.State {
		case Accepted:
			if tail || len(s.ClaimID) != 32 {
				return errors.New("invalid journal")
			}
		case Pending:
			if s.ClaimID != "" {
				return errors.New("invalid journal")
			}
			tail = true
		case InFlight, Rejected, Unknown:
			if tail || len(s.ClaimID) != 32 {
				return errors.New("invalid journal")
			}
			tail = true
		default:
			return errors.New("invalid journal")
		}
	}
	return nil
}

// ClaimNext produces a proposal, not a persisted lease. Version checks alone do
// not provide distributed idempotency: callers must CAS this proposal in storage.
// A crash or uncertainty leaves InFlight blocked; no automatic resume is allowed.
func ClaimNext(j Journal, expectedVersion uint64) (Journal, int, error) {
	if err := validate(j); err != nil {
		return j, -1, err
	}
	if j.Version != expectedVersion {
		return j, -1, errors.New("stale journal")
	}
	for i, s := range j.Steps {
		if s.State == Accepted {
			continue
		}
		if s.State != Pending {
			return j, -1, errors.New("route blocked")
		}
		id, err := randomID()
		if err != nil {
			return j, -1, err
		}
		next := clone(j)
		next.Steps[i].State = InFlight
		next.Steps[i].ClaimID = id
		next.Version++
		return next, i, nil
	}
	return j, -1, errors.New("all API responses accepted; vehicle verification still required")
}

// RecordResult accepts only a matching claimed step. Missing/malformed responses
// must be classified Unknown by the future transport, never Accepted.
// Duplicate identical receipts are read-only; conflicting receipts are rejected.
func RecordResult(j Journal, index int, claimID string, result StepState) (Journal, error) {
	if err := validate(j); err != nil {
		return j, err
	}
	if index < 0 || index >= len(j.Steps) || claimID == "" || j.Steps[index].ClaimID != claimID {
		return j, errors.New("receipt mismatch")
	}
	if result != Accepted && result != Rejected && result != Unknown {
		return j, errors.New("invalid result")
	}
	previous := j.Steps[index].State
	if previous == result {
		return j, nil
	}
	if previous != InFlight {
		return j, errors.New("receipt conflict")
	}
	next := clone(j)
	next.Steps[index].State = result
	next.Version++
	return next, nil
}

func Summarize(j Journal) (Summary, error) {
	if err := validate(j); err != nil {
		return Summary{}, err
	}
	s := Summary{TotalSteps: len(j.Steps)}
	for _, step := range j.Steps {
		if step.State == Accepted {
			s.AcceptedSteps++
		}
		if step.State == InFlight || step.State == Unknown || step.State == Rejected {
			s.Blocked = true
		}
	}
	s.AllAPIAccepted = s.AcceptedSteps == s.TotalSteps
	s.Partial = s.AcceptedSteps > 0 && !s.AllAPIAccepted
	// Never infer display verification or authorization for retransmission.
	return s, nil
}
