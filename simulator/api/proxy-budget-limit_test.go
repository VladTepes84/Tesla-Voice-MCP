package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProxyBudgetHonorsExistingConfiguredLimit(t *testing.T) {
	t.Setenv("TOKEN_STORE_REST_URL", "https://redis.invalid")
	t.Setenv("TOKEN_STORE_REST_TOKEN", "fixture")
	t.Setenv("VERCEL_ENV", "preview")
	for _, limit := range []int{1, 10, 25, 50} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			t.Setenv("TESLA_DAILY_READ_LIMIT", strconv.Itoa(limit))
			calls := 0
			base := wakeTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				var args []any
				if err := json.NewDecoder(r.Body).Decode(&args); err != nil {
					t.Fatal(err)
				}
				if args[53] != float64(limit) || args[2] != float64(50) {
					t.Fatal("configured limit or historical slot coverage changed")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"result":1}`)), Header: make(http.Header)}, nil
			})
			if err := reserveFleetHTTPRequest(context.Background(), base, time.Now()); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatal("reservation must be atomic and attempted once")
			}
		})
	}
	for _, invalid := range []string{"0", "51", "not-a-limit"} {
		t.Setenv("TESLA_DAILY_READ_LIMIT", invalid)
		base := wakeTransport(func(*http.Request) (*http.Response, error) { t.Fatal("invalid limit reached Redis"); return nil, nil })
		if reserveFleetHTTPRequest(context.Background(), base, time.Now()) == nil {
			t.Fatal("invalid limit accepted")
		}
	}
}
