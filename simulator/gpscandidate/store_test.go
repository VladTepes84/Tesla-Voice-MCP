package gpscandidate

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"tesla-voice-mcp/testsupport/redisfixture"
	"testing"
)

// Actual Redis process on a local Unix socket, no remote storage/credentials.
func actualRedis(t *testing.T) RedisCommand { t.Helper(); return redisfixture.Start(t) }

func TestActualRedisConcurrentClaimAndCrashRetention(t *testing.T) {
	command := actualRedis(t)
	ctx := context.Background()
	scope := strings.Repeat("a", 64)
	store, err := NewJournalStore(command, scope)
	if err != nil {
		t.Fatal(err)
	}
	j := journal(t)
	if err = store.Create(ctx, j); err != nil {
		t.Fatal(err)
	}
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			proposal, _, e := ClaimNext(j, 0)
			if e == nil && store.SaveProposal(ctx, j, proposal) == nil {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("expected one claim winner, got %d", winners.Load())
	}
	// New store instance represents another worker after a crash. In-flight stays
	// blocked and no timeout clears the permanent record or experimental guard.
	restarted, _ := NewJournalStore(command, scope)
	loaded, err := restarted.Load(ctx, j.RouteID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = ClaimNext(loaded, loaded.Version); err == nil {
		t.Fatal("crash permitted redispatch")
	}
	for _, key := range []string{store.prefix + j.RouteID, store.prefix + "guard"} {
		ttl, e := command(ctx, "TTL", key)
		if e != nil || ttl != int64(-1) {
			t.Fatal("guard/journal expires", ttl, e)
		}
	}
	other := journal(t)
	if err = store.Create(ctx, other); err == nil {
		t.Fatal("second route bypassed guard")
	}
	if err = store.Create(ctx, j); err == nil {
		t.Fatal("duplicate create overwrote receipt")
	}
}

func TestActualRedisPartialOutcomeAndScopeIsolation(t *testing.T) {
	command := actualRedis(t)
	ctx := context.Background()
	store, _ := NewJournalStore(command, strings.Repeat("b", 64))
	j := journal(t)
	if err := store.Create(ctx, j); err != nil {
		t.Fatal(err)
	}
	for k := 0; k < 2; k++ {
		before := j
		var i int
		j, i = claim(t, j)
		if err := store.SaveProposal(ctx, before, j); err != nil {
			t.Fatal(err)
		}
		before = j
		outcome := Accepted
		if k == 1 {
			outcome = Unknown
		}
		j = receipt(t, j, i, outcome)
		if err := store.SaveProposal(ctx, before, j); err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := store.Load(ctx, j.RouteID)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := Summarize(loaded)
	if !s.Partial || !s.Blocked || s.AcceptedSteps != 1 || loaded.Steps[2].State != Pending {
		t.Fatal("lost partial evidence", s)
	}
	if _, _, err := ClaimNext(loaded, loaded.Version); err == nil {
		t.Fatal("continued after unknown")
	}
	other, _ := NewJournalStore(command, strings.Repeat("c", 64))
	if _, err = other.Load(ctx, j.RouteID); err == nil {
		t.Fatal("cross-scope receipt read")
	}
	// Corruption cannot become 'not dispatched' or release a guard.
	_, err = command(ctx, "SET", store.prefix+j.RouteID, "{}")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Load(ctx, j.RouteID); err == nil {
		t.Fatal("corrupt journal accepted")
	}
	if err = store.Create(ctx, journal(t)); err == nil {
		t.Fatal("corruption released guard")
	}
}

func TestStoreErrorsAndInvalidTransitionsCannotAuthorizeSend(t *testing.T) {
	if _, err := NewJournalStore(nil, strings.Repeat("a", 64)); err == nil {
		t.Fatal("nil command")
	}
	called := false
	store, _ := NewJournalStore(func(context.Context, ...string) (any, error) {
		called = true
		return nil, fmt.Errorf("fixture secret must not escape")
	}, strings.Repeat("d", 64))
	j := journal(t)
	proposal, _ := claim(t, j)
	proposal.Steps[0].PayloadHash = strings.Repeat("0", 64)
	if err := store.SaveProposal(context.Background(), j, proposal); err == nil || called {
		t.Fatal("invalid payload reached storage")
	}
	proposal, _ = claim(t, j)
	err := store.SaveProposal(context.Background(), j, proposal)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("storage failure was accepted or leaked", err)
	}
}
