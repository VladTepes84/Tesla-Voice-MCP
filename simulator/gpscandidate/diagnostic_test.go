package gpscandidate

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestActualRedisGPSDiagnosticReplaceAppendIsUserGatedAndSingleUse(t *testing.T) {
	command := actualRedis(t)
	ctx := context.Background()
	vehicleScope := strings.Repeat("7", 64)
	accountScope := strings.Repeat("a", 64)
	otherAccount := strings.Repeat("b", 64)
	store, err := NewDiagnosticJournalStore(command, vehicleScope)
	if err != nil {
		t.Fatal(err)
	}
	points := []Point{{45.5499106, 9.0782851}, {45.4641669, 9.1916121}}
	const sessionID = "0123456789abcdef0123456789abcdef"
	journal, err := NewDiagnosticJournal(points, sessionID, accountScope, strings.Repeat("n", 43), time.Now().Add(15*time.Minute).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Create(ctx, journal); err != nil {
		t.Fatal(err)
	}
	if ttl, e := command(ctx, "PTTL", store.prefix+sessionID); e != nil || ttl.(int64) <= 0 {
		t.Fatal("diagnostic session must expire", ttl, e)
	}
	var sent []int
	preflightCalls := 0
	preflight := func(_ context.Context, count int) (func(), error) {
		preflightCalls++
		if count != 1 {
			t.Fatal("one phase must reserve one command")
		}
		return func() {}, nil
	}
	for _, test := range []struct {
		name string
		scope string
		index int
		point Point
	}{
		{"wrong account", otherAccount, 0, points[0]},
		{"append before replace", accountScope, 1, points[1]},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload, e := EncodeDiagnosticPoint(test.point, test.index == 1)
			if e != nil {
				t.Fatal(e)
			}
			_, e = RunDiagnosticPayload(ctx, store, sessionID, test.scope, test.index, payload, preflight, func(context.Context, int, []byte) (StepState, error) {
				t.Fatal("invalid diagnostic phase reached sender")
				return Unknown, nil
			})
			if e == nil {
				t.Fatal("invalid diagnostic phase accepted")
			}
		})
	}
	replace, _ := EncodeDiagnosticPoint(points[0], false)
	summary, err := RunDiagnosticPayload(ctx, store, sessionID, accountScope, 0, replace, preflight, func(_ context.Context, index int, payload []byte) (StepState, error) {
		if index != 0 || string(payload) != string(replace) {
			t.Fatal("Replace payload or order changed")
		}
		sent = append(sent, index)
		return Accepted, nil
	})
	if err != nil || summary.AcceptedSteps != 1 || summary.AllAPIAccepted || summary.VehicleRouteVerified || len(sent) != 1 {
		t.Fatal("Replace did not stop after one accepted send", summary, err, sent)
	}
	if guard, e := command(ctx, "GET", store.prefix+"guard"); e != nil || guard != sessionID {
		t.Fatal("session guard not retained between phases", guard, e)
	}
	if _, err = RunDiagnosticPayload(ctx, store, sessionID, accountScope, 0, replace, preflight, func(context.Context, int, []byte) (StepState, error) {
		t.Fatal("Replace retried")
		return Unknown, nil
	}); err == nil || len(sent) != 1 {
		t.Fatal("duplicate Replace was not blocked", err, sent)
	}
	appendPayload, _ := EncodeDiagnosticPoint(points[1], true)
	summary, err = RunDiagnosticPayload(ctx, store, sessionID, accountScope, 1, appendPayload, preflight, func(_ context.Context, index int, payload []byte) (StepState, error) {
		if index != 1 || string(payload) != string(appendPayload) {
			t.Fatal("Append payload or order changed")
		}
		sent = append(sent, index)
		return Accepted, nil
	})
	if err != nil || !summary.AllAPIAccepted || summary.AcceptedSteps != 2 || summary.VehicleRouteVerified || len(sent) != 2 || sent[0] != 0 || sent[1] != 1 {
		t.Fatal("Append did not complete the API journal in order", summary, err, sent)
	}
	if _, err = RunDiagnosticPayload(ctx, store, sessionID, accountScope, 1, appendPayload, preflight, func(context.Context, int, []byte) (StepState, error) {
		t.Fatal("Append retried")
		return Unknown, nil
	}); err == nil || len(sent) != 2 {
		t.Fatal("duplicate Append was not blocked", err, sent)
	}
	if released, e := store.ReconcileGuard(ctx); e != nil || !released {
		t.Fatal("proxy could not release the completed API journal", released, e)
	}
	if guard, e := command(ctx, "GET", store.prefix+"guard"); e != nil || guard != nil {
		t.Fatal("completed API journal guard was not released", guard, e)
	}
	if preflightCalls != 2 {
		t.Fatal("preflight should happen only for the two first attempts", preflightCalls)
	}
}

func TestActualRedisDiagnosticUnknownReplaceBlocksAppendAndRetry(t *testing.T) {
	command := actualRedis(t)
	ctx := context.Background()
	store, _ := NewDiagnosticJournalStore(command, strings.Repeat("8", 64))
	points := []Point{{45, 9}, {46, 10}}
	const id = "fedcba9876543210fedcba9876543210"
	account := strings.Repeat("c", 64)
	j, err := NewDiagnosticJournal(points, id, account, strings.Repeat("x", 43), time.Now().Add(10*time.Minute).UnixMilli())
	if err != nil || store.Create(ctx, j) != nil {
		t.Fatal("diagnostic setup failed", err)
	}
	var sent int
	replace, _ := EncodeDiagnosticPoint(points[0], false)
	preflight := func(context.Context, int) (func(), error) { return func() {}, nil }
	summary, err := RunDiagnosticPayload(ctx, store, id, account, 0, replace, preflight, func(context.Context, int, []byte) (StepState, error) {
		sent++
		return Unknown, context.DeadlineExceeded
	})
	if err == nil || !summary.Blocked || summary.AcceptedSteps != 0 || sent != 1 {
		t.Fatal("uncertain Replace was not retained", summary, err, sent)
	}
	appendPayload, _ := EncodeDiagnosticPoint(points[1], true)
	if _, err = RunDiagnosticPayload(ctx, store, id, account, 1, appendPayload, preflight, func(context.Context, int, []byte) (StepState, error) {
		sent++
		return Accepted, nil
	}); err == nil || sent != 1 {
		t.Fatal("Append followed an uncertain Replace", err, sent)
	}
	if _, err = RunDiagnosticPayload(ctx, store, id, account, 0, replace, preflight, func(context.Context, int, []byte) (StepState, error) {
		sent++
		return Accepted, nil
	}); err == nil || sent != 1 {
		t.Fatal("uncertain Replace retried", err, sent)
	}
}
