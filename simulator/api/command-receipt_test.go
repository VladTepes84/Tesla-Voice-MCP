package handler

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCommandReceiptNeverUsesElapsedTimeAsFailureEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, operation, body, state string
		code                         int
		forwarded                    bool
	}{
		{"success", "navigation_request", `{"accepted":true}`, "acknowledged", 200, true},
		{"rejected", "navigation_request", `{"error":"command_rejected"}`, "failed", 409, true},
		{"network", "navigation_request", `{"error":"command_outcome_unknown"}`, "uncertain", 502, true},
		{"timeout", "navigation_request", `{"error":"vehicle_unavailable"}`, "uncertain", 408, true},
		{"not sent", "navigation_request", `{"error":"command_upstream_unavailable"}`, "failed", 503, false},
		{"sdk failure cannot exclude earlier SDK effects", "door_lock", `{"error":"command_rejected"}`, "uncertain", 409, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			w.WriteHeader(tc.code)
			_, _ = w.WriteString(tc.body)
			receipt := commandReceipt(strings.Repeat("r", 43), tc.operation, tc.forwarded, w)
			if receipt["state"] != tc.state || receipt["definitive_no_effect"] != (tc.state == "failed") {
				t.Fatalf("incorrect receipt: %v", receipt)
			}
		})
	}
}

func TestNavigationMalformedResultsRemainUncertain(t *testing.T) {
	for _, body := range []string{`{}`, `{"response":{}}`, `{"response":{"result":true},"error":"contradiction"}`, `{"response":{"result":true}} {}`} {
		client := &http.Client{Transport: wakeTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})}
		w := httptest.NewRecorder()
		serveNavigationRequest(w, httptest.NewRequest(http.MethodPost, "/", nil), commandEnvelope{VIN: "5YJ3E1EA0LF000000", AccessToken: "fixture"}, []byte(`{}`), client)
		if w.Code != 502 || !strings.Contains(w.Body.String(), "command_outcome_unknown") {
			t.Fatal("malformed response became success or definitive rejection")
		}
	}
}

func TestHandlerPersistsSanitizedNavigationReceipts(t *testing.T) {
	for _, outcome := range []string{"accepted", "rejected", "lost_reply", "invalid_key"} {
		t.Run(outcome, func(t *testing.T) {
			for k, v := range map[string]string{
				"VERCEL_ENV": "production", "APP_ORIGIN": "https://mcp.example.invalid", "TESLA_FLEET_REGION": "eu",
				"TESLA_REAL_RELEASE_APPROVED": "true", "TESLA_BACKEND_ENABLED": "true", "TESLA_READ_ENABLED": "true", "TESLA_COMMANDS_ENABLED": "true", "TESLA_COMMAND_EXECUTION_ENABLED": "true",
				"TOKEN_STORE_REST_URL": "https://redis.invalid/", "TOKEN_STORE_REST_TOKEN": "fixture-store", "TOKEN_ENCRYPTION_KEY_BASE64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)),
			} {
				t.Setenv(k, v)
			}
			privateKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			der, _ := x509.MarshalECPrivateKey(privateKey)
			privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
			if outcome == "invalid_key" {
				privatePEM = "invalid"
			}
			nonce := strings.Repeat("n", 43)
			envelope := commandEnvelope{VIN: "5YJ3E1EA0LF000000", Operation: "navigation_request", Arguments: map[string]any{"destination": "PRIVATE_DESTINATION"}, AccessToken: "PRIVATE_ACCESS", PrivateKeyPEM: privatePEM, Nonce: nonce}
			data, _ := json.Marshal(envelope)
			timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
			derive := hmac.New(sha256.New, bytes.Repeat([]byte{7}, 32))
			_, _ = derive.Write([]byte("tesla-command-proxy-v1"))
			mac := hmac.New(sha256.New, derive.Sum(nil))
			_, _ = mac.Write([]byte(timestamp + "\n"))
			_, _ = mac.Write(data)
			req := httptest.NewRequest(http.MethodPost, "/api/tesla-command-proxy", bytes.NewReader(data))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Tesla-Command-Time", timestamp)
			req.Header.Set("X-Tesla-Command-Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
			original := http.DefaultTransport
			t.Cleanup(func() { http.DefaultTransport = original })
			var saved map[string]any
			fleetCalls := 0
			http.DefaultTransport = wakeTransport(func(r *http.Request) (*http.Response, error) {
				response := `{"result":"OK"}`
				if r.URL.Host == "redis.invalid" {
					var args []any
					if err := json.NewDecoder(r.Body).Decode(&args); err != nil {
						t.Fatal(err)
					}
					if strings.Contains(args[1].(string), "command-proxy-receipt:") {
						if len(args) != 4 || args[3] != "NX" {
							t.Fatal("receipt must be immutable and persistent")
						}
						raw := args[2].(string)
						if strings.Contains(raw, "PRIVATE") || strings.Contains(raw, envelope.VIN) || strings.Contains(raw, "BEGIN") {
							t.Fatal("sensitive receipt")
						}
						_ = json.Unmarshal([]byte(raw), &saved)
					}
				} else if r.URL.Host == "fleet-api.prd.eu.vn.cloud.tesla.com" {
					fleetCalls++
					if outcome == "lost_reply" {
						return nil, errors.New("fixture connection lost")
					}
					response = `{"response":{"result":true}}`
					if outcome == "rejected" {
						response = `{"response":{"result":false}}`
					}
				} else {
					t.Fatal("unexpected outbound destination")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(response)), Header: make(http.Header)}, nil
			})
			w := httptest.NewRecorder()
			Handler(w, req)
			expected := "acknowledged"
			if outcome == "rejected" || outcome == "invalid_key" {
				expected = "failed"
			}
			if outcome == "lost_reply" {
				expected = "uncertain"
			}
			if saved["state"] != expected {
				t.Fatalf("receipt = %v, response = %v", saved, w.Body.String())
			}
			expectedCalls := 1
			if outcome == "invalid_key" {
				expectedCalls = 0
			}
			if fleetCalls != expectedCalls {
				t.Fatalf("fleetCalls = %d", fleetCalls)
			}
		})
	}
}
