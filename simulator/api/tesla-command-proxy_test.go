package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestFleetTransportBudgetsEverySDKAttempt(t *testing.T) {
	t.Setenv("TOKEN_STORE_REST_URL", "https://redis.invalid")
	reserved, sent := 0, 0
	transport := fleetBudgetTransport{base: wakeTransport(func(r *http.Request) (*http.Response, error) {
		sent++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}, nil
	}), reserve: func(context.Context) error {
		reserved++
		if reserved > 2 {
			return errors.New("budget")
		}
		return nil
	}}
	for i := 0; i < 3; i++ {
		req, _ := http.NewRequest(http.MethodPost, "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/test/signed_command", nil)
		resp, err := transport.RoundTrip(req)
		if i < 2 {
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
		} else if err == nil {
			t.Fatal("budget must block third request")
		}
	}
	if reserved != 3 || sent != 2 {
		t.Fatalf("reserved=%d sent=%d", reserved, sent)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://untrusted.invalid", nil)
	if _, err := transport.RoundTrip(req); err == nil {
		t.Fatal("unexpected domain allowed")
	}
	if sent != 2 {
		t.Fatal("untrusted network request")
	}
}

func TestFleetHTTPRequestReservationUsesAllFiftyRedisKeys(t *testing.T) {
	t.Setenv("VERCEL_ENV", "preview")
	t.Setenv("TOKEN_STORE_REST_URL", "https://redis.invalid")
	t.Setenv("TOKEN_STORE_REST_TOKEN", "fake-store")
	t.Setenv("TESLA_DAILY_READ_LIMIT", "50")
	for _, result := range []int{1, 0, -1} {
		base := wakeTransport(func(r *http.Request) (*http.Response, error) {
			var args []any
			if err := json.NewDecoder(r.Body).Decode(&args); err != nil {
				t.Fatal(err)
			}
			if len(args) != 55 || args[0] != "EVAL" || args[2] != float64(50) || args[53] != float64(50) {
				t.Fatalf("unexpected reservation shape")
			}
			if args[3] != "tesla-voice:v1:read-budget:2026-11-02:0" || args[52] != "tesla-voice:v1:read-budget:2026-11-02:49" {
				t.Fatal("historical slots omitted")
			}
			body, _ := json.Marshal(map[string]int{"result": result})
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(body))), Header: make(http.Header)}, nil
		})
		err := reserveFleetHTTPRequest(context.Background(), base, time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
		if (err == nil) != (result == 1) {
			t.Fatalf("result %d: %v", result, err)
		}
	}
}

func TestProxyCommandArgumentsFormatsNavigationRequest(t *testing.T) {
	now := time.UnixMilli(1793628925123)
	got, err := proxyCommandArguments("navigation_request", map[string]any{
		"destination": "Milano Centrale",
	}, now)
	if err != nil {
		t.Fatalf("proxyCommandArguments returned error: %v", err)
	}
	want := map[string]any{
		"type":         "share_ext_content_raw",
		"locale":       "it-IT",
		"timestamp_ms": "1793628925123",
		"value":        map[string]string{"android.intent.extra.TEXT": "Milano Centrale"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("proxyCommandArguments = %#v, want %#v", got, want)
	}
}

func TestProxyCommandArgumentsLeavesOtherCommandsUntouched(t *testing.T) {
	args := map[string]any{"percent": float64(80)}
	got, err := proxyCommandArguments("set_charge_limit", args, time.UnixMilli(1))
	if err != nil {
		t.Fatalf("proxyCommandArguments returned error: %v", err)
	}
	if !reflect.DeepEqual(got, args) {
		t.Fatalf("proxyCommandArguments changed unrelated arguments: %#v", got)
	}
}

func TestGPSCandidateScopesAreStablePerActionAndIsolated(t *testing.T) {
	vin := "5YJ3E1EA7KF000000"
	actionA := strings.Repeat("A", 43)
	actionB := strings.Repeat("B", 43)
	scopeA, err := gpsRouteJournalScope(vin, actionA)
	if err != nil {
		t.Fatal(err)
	}
	scopeARepeat, err := gpsRouteJournalScope(vin, actionA)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := gpsRouteJournalScope(vin, actionB)
	if err != nil {
		t.Fatal(err)
	}
	scopeOtherVehicle, err := gpsRouteJournalScope("5YJ3E1EA0LF000001", actionA)
	if err != nil {
		t.Fatal(err)
	}
	if scopeA != scopeARepeat || scopeA == scopeB || scopeA == scopeOtherVehicle {
		t.Fatalf("action scopes are not stable and isolated")
	}
	if gpsNavigationGuardKey(vin, actionA) == gpsNavigationGuardKey(vin, actionB) {
		t.Fatal("navigation guards must be action-scoped")
	}
	if gpsNavigationGuardKey(vin, strings.Repeat("!", 43)) != "" {
		t.Fatal("invalid action scope accepted")
	}
	if gpsNavigationGuardKey(vin, "") == "" {
		t.Fatal("legacy diagnostic guard key must remain readable")
	}
}

func TestProxyCommandArgumentsMapsPINAndParentalSettingsToSDKNames(t *testing.T) {
	cases := []struct {
		operation string
		args      map[string]any
		want      map[string]any
	}{
		{"set_pin_to_drive", map[string]any{"on": true, "pin": "0123"}, map[string]any{"on": true, "password": "0123"}},
		{"set_valet_mode", map[string]any{"on": false}, map[string]any{"on": false}},
		{"parental_controls_enable_setting", map[string]any{"setting": "browser_blocked", "enable": true}, map[string]any{"setting": "BrowserBlocked", "enable": true}},
	}
	for _, testCase := range cases {
		got, err := proxyCommandArguments(testCase.operation, testCase.args, time.UnixMilli(1))
		if err != nil || !reflect.DeepEqual(got, testCase.want) {
			t.Fatalf("proxyCommandArguments(%s) = %#v, %v; want %#v", testCase.operation, got, err, testCase.want)
		}
	}
}

func TestValidateArgumentsRequiresValidPINAndParentalSettings(t *testing.T) {
	for _, testCase := range []struct {
		operation string
		args      map[string]any
		want      bool
	}{
		{"set_pin_to_drive", map[string]any{"on": true, "pin": "0123"}, true},
		{"set_pin_to_drive", map[string]any{"on": true, "pin": "12a3"}, false},
		{"set_valet_mode", map[string]any{"on": false}, true},
		{"set_valet_mode", map[string]any{"on": false, "pin": "0123"}, false},
		{"speed_limit_activate", map[string]any{"pin": "9876"}, true},
		{"parental_controls_activate", map[string]any{"pin": "0001"}, true},
		{"parental_controls_enable_setting", map[string]any{"setting": "browser_blocked", "enable": true}, true},
		{"parental_controls_enable_setting", map[string]any{"setting": "unknown", "enable": true}, false},
		{"parental_controls_set_speed_limit", map[string]any{"limit_mph": float64(65)}, true},
	} {
		if got := validateArguments(testCase.operation, testCase.args); got != testCase.want {
			t.Fatalf("validateArguments(%s, %#v) = %v, want %v", testCase.operation, testCase.args, got, testCase.want)
		}
	}
}

func TestProxyCommandArgumentsRejectsInvalidNavigationDestination(t *testing.T) {
	for _, destination := range []string{"", "   ", string(make([]byte, 257))} {
		if _, err := proxyCommandArguments("navigation_request", map[string]any{
			"destination": destination,
		}, time.UnixMilli(1)); err == nil {
			t.Fatalf("expected invalid destination to be rejected: %q", destination)
		}
	}
}

type wakeTransport func(*http.Request) (*http.Response, error)

func (f wakeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestNavigationRequestForwardsFormattedBodyOnceAndSanitizesResponse(t *testing.T) {
	body, err := proxyCommandArguments("navigation_request", map[string]any{"destination": "Milano Centrale"}, time.UnixMilli(1793628925123))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := &http.Client{Transport: wakeTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		gotBody, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if r.Method != http.MethodPost || r.URL.Host != "fleet-api.prd.eu.vn.cloud.tesla.com" || r.URL.Path != "/api/1/vehicles/5YJ3E1EA0LF000000/command/navigation_request" {
			t.Fatalf("incorrect navigation route: %s %s", r.Method, r.URL.String())
		}
		if r.Header.Get("Authorization") != "Bearer fake-test-token" || string(gotBody) != string(encoded) {
			t.Fatal("navigation request did not preserve its authorized payload")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"response":{"result":true}}`)), Header: make(http.Header)}, nil
	})}
	w := httptest.NewRecorder()
	serveNavigationRequest(w, httptest.NewRequest(http.MethodPost, "/", nil), commandEnvelope{VIN: "5YJ3E1EA0LF000000", AccessToken: "fake-test-token", Nonce: strings.Repeat("a", 43)}, encoded, client)
	if calls != 1 || w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"accepted":true`) ||
		strings.Contains(w.Body.String(), "fake-test-token") || strings.Contains(w.Body.String(), "command_id") {
		t.Fatalf("unexpected navigation result: calls=%d status=%d body=%s", calls, w.Code, w.Body.String())
	}
}

func TestNavigationNetworkFailureDoesNotRetry(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: wakeTransport(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("private-network-details")
	})}
	w := httptest.NewRecorder()
	serveNavigationRequest(w, httptest.NewRequest(http.MethodPost, "/", nil), commandEnvelope{VIN: "5YJ3E1EA0LF000000", AccessToken: "fake-test-token", Nonce: strings.Repeat("a", 43)}, []byte(`{"payload":"fake"}`), client)
	if calls != 1 || w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "command_outcome_unknown") || strings.Contains(w.Body.String(), "private-network-details") {
		t.Fatalf("unexpected navigation failure: calls=%d status=%d body=%s", calls, w.Code, w.Body.String())
	}
}

func TestWakeUsesDedicatedRESTEndpointAndAcceptsVehicleState(t *testing.T) {
	for _, state := range []string{"online", "asleep", "offline"} {
		calls := 0
		client := &http.Client{Transport: wakeTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.Method != "POST" || r.URL.Host != "fleet-api.prd.eu.vn.cloud.tesla.com" || r.URL.Path != "/api/1/vehicles/5YJ3E1EA0LF000000/wake_up" {
				t.Fatalf("incorrect wake route: %s %s", r.Method, r.URL.Path)
			}
			if r.Header.Get("Authorization") != "Bearer fake-test-token" || r.Header.Get("Content-Type") != "application/json" {
				t.Fatal("missing request headers")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"response":{"state":"` + state + `"}}`)), Header: make(http.Header)}, nil
		})}
		w := httptest.NewRecorder()
		serveWake(w, httptest.NewRequest("POST", "/", nil), commandEnvelope{VIN: "5YJ3E1EA0LF000000", AccessToken: "fake-test-token", Nonce: strings.Repeat("a", 43)}, client)
		if calls != 1 || w.Code != 200 || !strings.Contains(w.Body.String(), `"accepted":true`) {
			t.Fatalf("unexpected wake result: %d %s (%d calls)", w.Code, w.Body.String(), calls)
		}
		if strings.Contains(w.Body.String(), "state") || strings.Contains(w.Body.String(), "fake-test-token") || strings.Contains(w.Body.String(), "command_id") {
			t.Fatal("private upstream payload exposed")
		}
	}
}

func TestWakeRejectsMalformedResponsesAndDoesNotRetry(t *testing.T) {
	for _, body := range []string{`{}`, `{"response":{"result":true}}`, `{"response":{"state":"unknown"}}`, `{"response":{"state":"online"},"error":"failure"}`, `{"response":{"state":"online"}} {}`} {
		calls := 0
		client := &http.Client{Transport: wakeTransport(func(*http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})}
		w := httptest.NewRecorder()
		serveWake(w, httptest.NewRequest("POST", "/", nil), commandEnvelope{VIN: "5YJ3E1EA0LF000000", Nonce: strings.Repeat("a", 43)}, client)
		if calls != 1 || w.Code != 502 || !strings.Contains(w.Body.String(), "command_outcome_unknown") {
			t.Fatalf("unexpected result: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestWakeNetworkFailureRemainsUnknownWithoutRetry(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: wakeTransport(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("private-network-details")
	})}
	w := httptest.NewRecorder()
	serveWake(w, httptest.NewRequest("POST", "/", nil), commandEnvelope{VIN: "5YJ3E1EA0LF000000", Nonce: strings.Repeat("a", 43)}, client)
	if calls != 1 || w.Code != 502 || !strings.Contains(w.Body.String(), "command_outcome_unknown") || strings.Contains(w.Body.String(), "private-network-details") {
		t.Fatalf("unexpected result %d %s", w.Code, w.Body.String())
	}
}

func TestConfiguredPublicOriginIsCanonicalHTTPS(t *testing.T) {
	for _, origin := range []string{"https://mcp.example.invalid", "https://another.example.invalid"} {
		if !validPublicOrigin(origin) {
			t.Fatalf("valid operator origin rejected")
		}
	}
	for _, origin := range []string{"", "http://mcp.example.invalid", "https://mcp.example.invalid/path", "https://mcp.example.invalid:444", "https://127.0.0.1"} {
		if validPublicOrigin(origin) {
			t.Fatalf("invalid origin accepted")
		}
	}
}
