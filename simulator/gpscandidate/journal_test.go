package gpscandidate

import "testing"

func journal(t *testing.T) Journal {
	t.Helper()
	j, err := NewJournal([]Point{{45, 9}, {46, 10}, {45, 9}})
	if err != nil {
		t.Fatal(err)
	}
	return j
}
func claim(t *testing.T, j Journal) (Journal, int) {
	t.Helper()
	n, i, e := ClaimNext(j, j.Version)
	if e != nil {
		t.Fatal(e)
	}
	return n, i
}
func receipt(t *testing.T, j Journal, i int, state StepState) Journal {
	t.Helper()
	n, e := RecordResult(j, i, j.Steps[i].ClaimID, state)
	if e != nil {
		t.Fatal(e)
	}
	return n
}

func TestCrashAfterClaimBlocksAllFurtherSteps(t *testing.T) {
	j := journal(t)
	claimed, i := claim(t, j)
	if i != 0 || j.Steps[0].State != Pending {
		t.Fatal("input journal mutated")
	}
	if _, _, err := ClaimNext(claimed, claimed.Version); err == nil {
		t.Fatal("in-flight step retransmitted")
	}
	if _, _, err := ClaimNext(claimed, 0); err == nil {
		t.Fatal("stale version accepted")
	}
	s, err := Summarize(claimed)
	if err != nil || !s.Blocked || s.RetryAllowed {
		t.Fatal("crash not blocked")
	}
}
func TestUncertainSecondStepPreservesPartialReceipt(t *testing.T) {
	j, i := claim(t, journal(t))
	j = receipt(t, j, i, Accepted)
	j, i = claim(t, j)
	j = receipt(t, j, i, Unknown)
	if _, _, err := ClaimNext(j, j.Version); err == nil {
		t.Fatal("continued after uncertainty")
	}
	s, err := Summarize(j)
	if err != nil || !s.Partial || !s.Blocked || s.AcceptedSteps != 1 || s.AllAPIAccepted || s.VehicleRouteVerified || s.RetryAllowed {
		t.Fatal(s, err)
	}
	if j.Steps[0].State != Accepted || j.Steps[2].State != Pending {
		t.Fatal("lost receipt or sent next step")
	}
}
func TestRejectedStepDoesNotTriggerReplacementOrRollback(t *testing.T) {
	j, i := claim(t, journal(t))
	j = receipt(t, j, i, Rejected)
	if _, _, err := ClaimNext(j, j.Version); err == nil {
		t.Fatal("retried rejected route")
	}
	if j.Steps[1].State != Pending {
		t.Fatal("continued after rejection")
	}
}
func TestDuplicateReceiptReadOnlyAndConflictsRejected(t *testing.T) {
	j, i := claim(t, journal(t))
	id := j.Steps[i].ClaimID
	if _, err := RecordResult(j, i, "wrong", Accepted); err == nil {
		t.Fatal("foreign receipt accepted")
	}
	if _, err := RecordResult(j, i+1, id, Accepted); err == nil {
		t.Fatal("wrong step accepted")
	}
	j = receipt(t, j, i, Accepted)
	again, err := RecordResult(j, i, id, Accepted)
	if err != nil || again.Version != j.Version {
		t.Fatal("duplicate receipt changed version")
	}
	if _, err := RecordResult(j, i, id, Unknown); err == nil {
		t.Fatal("conflicting result overwrote acceptance")
	}
}
func TestAllAcceptedDoesNotClaimVehicleDisplayVerified(t *testing.T) {
	j := journal(t)
	for k := 0; k < 3; k++ {
		var i int
		j, i = claim(t, j)
		if i != k {
			t.Fatal("wrong step order")
		}
		j = receipt(t, j, i, Accepted)
	}
	s, err := Summarize(j)
	if err != nil || !s.AllAPIAccepted || s.VehicleRouteVerified || s.RetryAllowed || s.Partial {
		t.Fatal(s, err)
	}
	if _, _, err := ClaimNext(j, j.Version); err == nil {
		t.Fatal("completed sequence sent again")
	}
}
func TestCorruptedJournalAndInvalidRouteFailClosed(t *testing.T) {
	if _, err := NewJournal([]Point{{0, 0}}); err == nil {
		t.Fatal("bad route")
	}
	j := journal(t)
	j.Steps[1].State = Accepted
	j.Steps[1].ClaimID = "0123456789abcdef0123456789abcdef"
	if _, _, err := ClaimNext(j, j.Version); err == nil {
		t.Fatal("impossible receipt order")
	}
	if _, err := Summarize(j); err == nil {
		t.Fatal("corrupt summary accepted")
	}
}
