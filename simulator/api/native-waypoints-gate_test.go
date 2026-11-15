package handler

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNativeGateRejectsBeforeRedisOrFleet(t *testing.T) {
	for k, v := range map[string]string{"VERCEL_ENV": "production", "APP_ORIGIN": "https://mcp.example.invalid", "TESLA_FLEET_REGION": "eu", "TESLA_REAL_RELEASE_APPROVED": "true", "TESLA_BACKEND_ENABLED": "true", "TESLA_READ_ENABLED": "true", "TESLA_COMMANDS_ENABLED": "true", "TESLA_COMMAND_EXECUTION_ENABLED": "true", "TESLA_NATIVE_WAYPOINTS_ENABLED": "false"} {
		t.Setenv(k, v)
	}
	key := bytes.Repeat([]byte{7}, 32)
	t.Setenv("TOKEN_ENCRYPTION_KEY_BASE64", base64.StdEncoding.EncodeToString(key))
	t.Setenv("TOKEN_ENCRYPTON_KEY_BASE64", "")
	before := http.DefaultTransport
	http.DefaultTransport = wakeTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("disabled operation contacted Redis/Fleet")
		return nil, nil
	})
	t.Cleanup(func() { http.DefaultTransport = before })
	e := commandEnvelope{VIN: "5YJ3E1EA0LF000000", Operation: "navigation_waypoints_request", Arguments: map[string]any{"waypoints": "refId:FIXTURE_AAAA,refId:FIXTURE_BBBB"}, AccessToken: "fixture-access", PrivateKeyPEM: "fixture-key", Nonce: strings.Repeat("a", 43)}
	data, _ := json.Marshal(e)
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	derive := hmac.New(sha256.New, key)
	_, _ = io.WriteString(derive, "tesla-command-proxy-v1")
	signature := hmac.New(sha256.New, derive.Sum(nil))
	_, _ = io.WriteString(signature, stamp+"\n")
	_, _ = signature.Write(data)
	req := httptest.NewRequest("POST", "https://mcp.example.invalid/api/tesla-command-proxy", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tesla-Command-Time", stamp)
	req.Header.Set("X-Tesla-Command-Signature", base64.RawURLEncoding.EncodeToString(signature.Sum(nil)))
	rec := httptest.NewRecorder()
	Handler(rec, req)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "command_transport_unsupported") {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
}
func TestNativeValidationIsStrictInProxy(t *testing.T) {
	if !validateArguments("navigation_waypoints_request", map[string]any{"waypoints": "refId:FIXTURE_AAAA,refId:FIXTURE_BBBB"}) {
		t.Fatal("valid rejected")
	}
	for _, args := range []map[string]any{{"waypoints": "Laketown,Hilltown"}, {"waypoints": "refId:FIXTURE_AAAA,refId:FIXTURE_BBBB", "trip_plan_options": map[string]any{}}, {"waypoints": []any{"one", "two"}}} {
		if validateArguments("navigation_waypoints_request", args) {
			t.Fatal("invalid accepted")
		}
	}
}
