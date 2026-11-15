package gpscandidate

// Experimental coordinator behind the internal proxy gate. It cannot certify
// GPS order semantics; no request is authorized merely by calling these transitions.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"
)

type RouteJournalStore interface {
	Load(context.Context, string) (Journal, error)
	SaveProposal(context.Context, Journal, Journal) error
}

// RunDiagnosticPayload executes exactly one pre-encoded GPS step from a
// two-step diagnostic journal. It never selects or sends the following step.
// The expected account scope and payload hash are checked before claiming it.
func RunDiagnosticPayload(parent context.Context, store RouteJournalStore, id, accountScope string, index int, payload []byte, preflight Preflight, send StepSender) (Summary, error) {
	if store == nil || preflight == nil || send == nil || !hexScope.MatchString(accountScope) || index < 0 || index > 1 || len(payload) == 0 {
		return Summary{}, errors.New("diagnostic runner not configured")
	}
	ctx, cancel := context.WithTimeout(parent, 24*time.Second)
	defer cancel()
	j, err := store.Load(ctx, id)
	if err != nil {
		return Summary{}, err
	}
	if j.AccountScope != accountScope || j.ExpiresAtMS <= time.Now().UnixMilli() || len(j.Steps) != 2 {
		return Summary{}, errors.New("diagnostic session unavailable")
	}
	sum := sha256.Sum256(payload)
	if hex.EncodeToString(sum[:]) != j.Steps[index].PayloadHash {
		return Summary{}, errors.New("diagnostic payload mismatch")
	}
	if index == 1 && j.Steps[0].State != Accepted {
		return Summary{}, errors.New("diagnostic replace not accepted")
	}
	summary, err := Summarize(j)
	if err != nil {
		return Summary{}, err
	}
	if index < summary.AcceptedSteps || j.Steps[index].State != Pending {
		return summary, errors.New("diagnostic phase already attempted; no retry")
	}
	claimed, claimedIndex, err := ClaimNext(j, j.Version)
	if err != nil || claimedIndex != index {
		return summary, errors.New("diagnostic phase out of order")
	}
	if err = store.SaveProposal(ctx, j, claimed); err != nil {
		return summary, err
	}
	j = claimed
	release, err := preflight(ctx, 1)
	if err != nil || release == nil {
		// This error precedes Vehicle.Send, so it is recorded as a terminal
		// rejection. A repeated phase is still blocked by the journal.
		next, recordErr := RecordResult(j, index, j.Steps[index].ClaimID, Rejected)
		if recordErr == nil {
			recordErr = store.SaveProposal(ctx, j, next)
		}
		summary, _ = Summarize(next)
		if recordErr != nil {
			return summary, errors.New("diagnostic preflight failed; receipt not durable")
		}
		return summary, errors.New("diagnostic preflight failed; no dispatch")
	}
	defer release()
	if err = ctx.Err(); err != nil {
		summary, _ = Summarize(j)
		return summary, errors.New("diagnostic deadline reached; no dispatch")
	}
	outcome := sendOnce(ctx, send, index, payload)
	next, recordErr := RecordResult(j, index, j.Steps[index].ClaimID, outcome)
	if recordErr == nil {
		recordErr = store.SaveProposal(ctx, j, next)
	}
	if recordErr != nil {
		summary, _ = Summarize(j)
		return summary, errors.New("diagnostic receipt not durable; no retry")
	}
	summary, _ = Summarize(next)
	if outcome != Accepted {
		return summary, errors.New("diagnostic phase was not accepted; no retry")
	}
	return summary, nil
}

// Preflight is a REQUIRED future bridge to the existing vehicle guard and total
// request budget. A successful callback must hold its guard for this entire run.
// The fixture callbacks in tests are not proof of that production integration.
type Preflight func(context.Context, int) (release func(), err error)
type StepSender func(context.Context, int, []byte) (StepState, error)

// RunPrepared runs an already-created, indexed route at most once. It never
// creates a new route or resumes a partially attempted route on a repeated call.
// A full API-accepted record can be read again without any sender/preflight call.
func RunPrepared(parent context.Context, store RouteJournalStore, id string, points []Point, preflight Preflight, send StepSender) (Summary, error) {
	if store == nil || preflight == nil || send == nil {
		return Summary{}, errors.New("runner not configured")
	}
	ctx, cancel := context.WithTimeout(parent, 24*time.Second)
	defer cancel()
	payloads, err := EncodeRoute(points)
	if err != nil {
		return Summary{}, err
	}
	j, err := store.Load(ctx, id)
	if err != nil {
		return Summary{}, err
	}
	if len(j.Steps) != len(payloads) {
		return Summary{}, errors.New("route payload mismatch")
	}
	for i, payload := range payloads {
		sum := sha256.Sum256(payload)
		if hex.EncodeToString(sum[:]) != j.Steps[i].PayloadHash {
			return Summary{}, errors.New("route payload mismatch")
		}
	}
	summary, err := Summarize(j)
	if err != nil {
		return Summary{}, err
	}
	if summary.AllAPIAccepted {
		return summary, nil
	}
	for _, step := range j.Steps {
		if step.State != Pending {
			return summary, errors.New("route already attempted; no automatic resume")
		}
	}
	// Persist the first claim before preflight, so competing workers cannot reserve
	// another budget or enter the sender. Failure/crash retains the permanent guard.
	claimed, index, err := ClaimNext(j, j.Version)
	if err != nil {
		return summary, err
	}
	if err = store.SaveProposal(ctx, j, claimed); err != nil {
		return summary, err
	}
	j = claimed
	release, err := preflight(ctx, len(payloads))
	if err != nil || release == nil {
		summary, _ = Summarize(j)
		return summary, errors.New("route preflight failed; no dispatch")
	}
	defer release()
	for {
		if err = ctx.Err(); err != nil {
			summary, _ = Summarize(j)
			return summary, errors.New("route deadline reached; no further dispatch")
		}
		outcome := sendOnce(ctx, send, index, payloads[index])
		next, recordErr := RecordResult(j, index, j.Steps[index].ClaimID, outcome)
		if recordErr != nil {
			summary, _ = Summarize(j)
			return summary, recordErr
		}
		if err = store.SaveProposal(ctx, j, next); err != nil {
			summary, _ = Summarize(j)
			return summary, errors.New("receipt not durable; no further dispatch")
		}
		j = next
		summary, _ = Summarize(j)
		if outcome != Accepted {
			return summary, errors.New("route stopped after unaccepted step")
		}
		if summary.AllAPIAccepted {
			return summary, nil
		}
		if err = ctx.Err(); err != nil {
			return summary, errors.New("route deadline reached; no further dispatch")
		}
		claimed, index, err = ClaimNext(j, j.Version)
		if err != nil {
			return summary, err
		}
		if err = store.SaveProposal(ctx, j, claimed); err != nil {
			return summary, err
		}
		j = claimed
	}
}

func sendOnce(ctx context.Context, send StepSender, index int, payload []byte) (result StepState) {
	result = Unknown
	defer func() {
		if recover() != nil {
			result = Unknown
		}
	}()
	stepCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	outcome, err := send(stepCtx, index, append([]byte(nil), payload...))
	if err != nil || stepCtx.Err() != nil {
		return Unknown
	}
	if outcome != Accepted && outcome != Rejected {
		return Unknown
	}
	return outcome
}
