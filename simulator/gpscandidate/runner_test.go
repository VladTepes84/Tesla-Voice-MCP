package gpscandidate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestActualRedisRunnerSequenceAndReplay(t *testing.T) {
	command := actualRedis(t)
	store, _ := NewJournalStore(command, strings.Repeat("e", 64))
	points := []Point{{45, 9}, {46, 10}, {45, 9}}
	j, err := NewJournal(points)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Create(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	var sent, reserved, released int
	preflight := func(ctx context.Context, n int) (func(), error) {
		reserved++
		if n != 3 {
			t.Fatal("wrong total reservation")
		}
		return func() { released++ }, nil
	}
	send := func(ctx context.Context, index int, payload []byte) (StepState, error) {
		durable, e := store.Load(ctx, j.RouteID)
		if e != nil || durable.Steps[index].State != InFlight {
			t.Fatal("send before durable claim", e)
		}
		if index != sent {
			t.Fatal("wrong order")
		}
		sent++
		return Accepted, nil
	}
	summary, err := RunPrepared(context.Background(), store, j.RouteID, points, preflight, send)
	if err != nil || !summary.AllAPIAccepted || summary.VehicleRouteVerified || sent != 3 || reserved != 1 || released != 1 {
		t.Fatal(summary, err, sent, reserved, released)
	}
	_, err = RunPrepared(context.Background(), store, j.RouteID, points, preflight, send)
	if err != nil || sent != 3 || reserved != 1 {
		t.Fatal("replay dispatched or reserved again", err)
	}
}

func TestActualRedisRunnerStopsOnUnknownOrRejection(t *testing.T) {
	command := actualRedis(t)
	for k, outcome := range []StepState{Unknown, Rejected} {
		scope := strings.Repeat([]string{"a", "b"}[k], 64)
		store, _ := NewJournalStore(command, scope)
		points := []Point{{45, 9}, {46, 10}, {47, 11}}
		j, _ := NewJournal(points)
		if err := store.Create(context.Background(), j); err != nil {
			t.Fatal(err)
		}
		sent := 0
		preflight := func(context.Context, int) (func(), error) { return func() {}, nil }
		send := func(context.Context, int, []byte) (StepState, error) {
			sent++
			if sent == 1 {
				return Accepted, nil
			}
			return outcome, nil
		}
		s, err := RunPrepared(context.Background(), store, j.RouteID, points, preflight, send)
		if err == nil || !s.Partial || !s.Blocked || sent != 2 {
			t.Fatal(s, err, sent)
		}
		_, err = RunPrepared(context.Background(), store, j.RouteID, points, preflight, send)
		if err == nil || sent != 2 {
			t.Fatal("partial route resumed")
		}
		loaded, e := store.Load(context.Background(), j.RouteID)
		if e != nil || loaded.Steps[2].State != Pending {
			t.Fatal("third stop attempted", e)
		}
	}
}

type failingStore struct {
	RouteJournalStore
	fail bool
}

func (s *failingStore) SaveProposal(ctx context.Context, before, after Journal) error {
	if s.fail {
		return errors.New("storage fixture unavailable")
	}
	return s.RouteJournalStore.SaveProposal(ctx, before, after)
}

func TestActualRedisRunnerStorageFailureAndPreflightDenial(t *testing.T) {
	command := actualRedis(t)
	points := []Point{{45, 9}, {46, 10}}
	ctx := context.Background()
	for k := 0; k < 3; k++ {
		store, _ := NewJournalStore(command, strings.Repeat([]string{"c", "d", "f"}[k], 64))
		j, _ := NewJournal(points)
		if err := store.Create(ctx, j); err != nil {
			t.Fatal(err)
		}
		wrapper := &failingStore{RouteJournalStore: store, fail: k == 0}
		sent := 0
		preflightCalls := 0
		preflight := func(context.Context, int) (func(), error) {
			preflightCalls++
			if k == 1 {
				return nil, errors.New("budget denied fixture")
			}
			return func() {}, nil
		}
		send := func(context.Context, int, []byte) (StepState, error) {
			sent++
			wrapper.fail = true
			return Accepted, nil
		}
		s, err := RunPrepared(ctx, wrapper, j.RouteID, points, preflight, send)
		if err == nil || s.AllAPIAccepted || s.VehicleRouteVerified {
			t.Fatal("failure became success", s, err)
		}
		if k < 2 && sent != 0 {
			t.Fatal("sent despite missing storage/budget")
		}
		if k == 0 && preflightCalls != 0 {
			t.Fatal("preflight before winning CAS")
		}
		if k == 2 && sent != 1 {
			t.Fatal("continued without durable receipt")
		}
	}
}

func TestActualRedisRouteDeadlineRetainsPartialAndBlocksRetry(t *testing.T) {
	command := actualRedis(t)
	store, _ := NewJournalStore(command, strings.Repeat("8", 64))
	points := []Point{{45, 9}, {46, 10}, {47, 11}}
	j, _ := NewJournal(points)
	if err := store.Create(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	sent := 0
	started := time.Now()
	_, err := RunPrepared(ctx, store, j.RouteID, points, func(context.Context, int) (func(), error) { return func() {}, nil }, func(ctx context.Context, index int, _ []byte) (StepState, error) {
		sent++
		if index == 0 {
			return Accepted, nil
		}
		<-ctx.Done()
		return Unknown, ctx.Err()
	})
	if err == nil || sent != 2 || time.Since(started) > 2*time.Second {
		t.Fatal("deadline did not stop sequence", err, sent)
	}
	loaded, err := store.Load(context.Background(), j.RouteID)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := Summarize(loaded)
	if err != nil || summary.AcceptedSteps != 1 || !summary.Blocked || !summary.Partial || loaded.Steps[2].State != Pending {
		t.Fatal("partial receipt lost", summary, err)
	}
	if _, _, err = ClaimNext(loaded, loaded.Version); err == nil {
		t.Fatal("timeout authorized replay")
	}
	if ttl, e := command(context.Background(), "TTL", store.prefix+"guard"); e != nil || ttl != int64(-1) {
		t.Fatal("timeout expired permanent guard", ttl, e)
	}
}
