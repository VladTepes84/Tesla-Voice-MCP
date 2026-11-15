package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"tesla-voice-mcp/gpscandidate"
	"tesla-voice-mcp/testsupport/redisfixture"
	"testing"
	"time"
)

func TestUnlimitedBudgetCountsBeyond50WithoutErasingLegacyAndCanRestoreCap(t *testing.T) {
	t.Setenv("TOKEN_STORE_REST_URL", "https://redis.fixture.invalid/")
	t.Setenv("TOKEN_STORE_REST_TOKEN", "fixture")
	t.Setenv("VERCEL_ENV", "production")
	t.Setenv("TESLA_DAILY_READ_LIMIT", "50")
	command := gpscandidate.RedisCommand(redisfixture.Start(t))
	ctx := context.Background()
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	day := "2026-11-05"
	for i := 0; i < 50; i++ {
		if _, err := command(ctx, "SET", fmt.Sprintf("tesla-voice:v1:read-budget:%s:%d", day, i), "1", "EX", "172800"); err != nil {
			t.Fatal(err)
		}
	}
	base := wakeTransport(func(r *http.Request) (*http.Response, error) {
		var raw []any
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			t.Fatal(err)
		}
		args := make([]string, len(raw))
		for i, v := range raw {
			args[i] = fmt.Sprint(v)
		}
		v, err := command(r.Context(), args...)
		if err != nil {
			return nil, err
		}
		body, _ := json.Marshal(map[string]any{"result": v})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body))}, nil
	})
	for i := 0; i < 60; i++ {
		if err := reserveFleetHTTPRequest(ctx, base, now); err != nil {
			t.Fatal(err)
		}
	}
	extra, _ := command(ctx, "GET", "tesla-voice:v1:read-budget-extra:"+day)
	if extra != "60" {
		t.Fatal("unmetered unlimited traffic", extra)
	}
	legacy, _ := command(ctx, "GET", "tesla-voice:v1:read-budget:"+day+":49")
	if legacy != "1" {
		t.Fatal("legacy reservation erased")
	}
	t.Setenv("VERCEL_ENV", "preview")
	t.Setenv("TESLA_DAILY_READ_LIMIT", "50")
	if reserveFleetHTTPRequest(ctx, base, now) == nil {
		t.Fatal("restored cap ignored unlimited usage")
	}
	t.Setenv("VERCEL_ENV", "production")
	t.Setenv("TESLA_DAILY_READ_LIMIT", "")
	if err := reserveFleetHTTPRequest(ctx, base, now); err != nil {
		t.Fatal("Production still required the legacy quota variable", err)
	}
	extra, _ = command(ctx, "GET", "tesla-voice:v1:read-budget-extra:"+day)
	if extra != "61" {
		t.Fatal("Production without the legacy variable was not metered", extra)
	}
	t.Setenv("TESLA_DAILY_READ_LIMIT", "unlimited")
	command(ctx, "SET", "tesla-voice:v1:read-budget-extra:"+day, "corrupt")
	if reserveFleetHTTPRequest(ctx, base, now) == nil {
		t.Fatal("corrupt meter allowed request")
	}
}
