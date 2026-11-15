package navigationcontracts

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/connector/inet"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"tesla-voice-mcp/gpscandidate"
	"tesla-voice-mcp/nativewaypoints"
	"testing"
	"time"
)

type failingVehicle struct {
	phase                        string
	sent, sessions, disconnected int
}

type sessionHTTPFixture func(*http.Request) (*http.Response, error)

func (f sessionHTTPFixture) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func (v *failingVehicle) Connect(context.Context) error {
	if v.phase == "connect" {
		return errors.New("secret-token VIN upstream")
	}
	return nil
}
func (v *failingVehicle) Disconnect() { v.disconnected++ }
func (v *failingVehicle) StartSession(context.Context, []universal.Domain) error {
	v.sessions++
	if v.phase == "session" {
		return &inet.HTTPError{Code: 403, Message: "secret-token VIN upstream"}
	}
	return nil
}
func (v *failingVehicle) Send(context.Context, universal.Domain, []byte, connector.AuthMethod) ([]byte, error) {
	v.sent++
	if v.phase == "send" {
		return nil, errors.New("secret-token VIN upstream")
	}
	return []byte{255}, nil
}

func TestFailuresIdentifyPhaseWithoutLeakingSDKDetailsOrSendingAfterPreflightFailure(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "key.pem")
	if err = os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: raw}), 0600); err != nil {
		t.Fatal(err)
	}
	signingKey, err := protocol.LoadPrivateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("actual_sdk_forbidden_handshake", func(t *testing.T) {
		previous := http.DefaultTransport
		t.Cleanup(func() { http.DefaultTransport = previous })
		posts := 0
		http.DefaultTransport = sessionHTTPFixture(func(r *http.Request) (*http.Response, error) {
			posts++
			if r.URL.Host != "fleet-api.prd.eu.vn.cloud.tesla.com" || !strings.HasSuffix(r.URL.Path, "/signed_command") || r.Header.Get("Authorization") != "Bearer fixture-token" {
				t.Fatal("unexpected signed transport")
			}
			return &http.Response{StatusCode: 403, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("secret-token VIN upstream"))}, nil
		})
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		factory := func(c nativewaypoints.Command, k protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
			return gpscandidate.NewBudgetedSingleVehicle(ctx, c, k)
		}
		err := RunSingle(ctx, []byte{1}, nativewaypoints.Command{VIN: "5YJ3E1EA0LF000000", AccessToken: "fixture-token"}, signingKey, factory, func(context.Context) error { return nil }, func(context.Context) error { t.Fatal("command after rejected handshake"); return nil })
		reason, status, _ := FailureDiagnostic(err)
		if !errors.Is(err, ErrPreflight) || FailurePhase(err) != "session" || reason != "http_error" || status != 403 || posts != 1 {
			t.Fatalf("SDK diagnosis lost: %v %s %d posts=%d", err, reason, status, posts)
		}
	})
	for _, phase := range []string{"vehicle_factory", "connect", "session", "guard_before_session", "guard_before_dispatch", "send", "response_decode"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			car := &failingVehicle{phase: phase}
			factory := func(nativewaypoints.Command, protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
				if phase == "vehicle_factory" {
					return nil, errors.New("secret-token")
				}
				return car, nil
			}
			verify := func(context.Context) error {
				if phase == "guard_before_session" {
					return errors.New("secret-token")
				}
				return nil
			}
			dispatched := false
			before := func(context.Context) error {
				if phase == "guard_before_dispatch" {
					return errors.New("secret-token")
				}
				dispatched = true
				return nil
			}
			err := RunSingle(ctx, []byte{1}, nativewaypoints.Command{}, signingKey, factory, verify, before)
			category := ErrPreflight
			if phase == "send" || phase == "response_decode" {
				category = ErrUnknown
			}
			if !errors.Is(err, category) || FailurePhase(err) != phase {
				t.Fatalf("incorrect classification: %v", err)
			}
			if phase == "session" {
				reason, status, _ := FailureDiagnostic(err)
				if reason != "http_error" || status != 403 {
					t.Fatal("session error discarded")
				}
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "VIN") {
				t.Fatal("upstream details leaked")
			}
			if category == ErrPreflight && (car.sent != 0 || dispatched) {
				t.Fatal("dispatch after failed preflight")
			}
			if category == ErrUnknown && (car.sent != 1 || !dispatched) {
				t.Fatal("ambiguous send must stay dispatched and never retry")
			}
			if phase == "connect" && car.sessions != 0 {
				t.Fatal("session after failed connect")
			}
			if phase != "guard_before_session" && phase != "vehicle_factory" && car.disconnected != 1 {
				t.Fatal("missing cleanup")
			}
		})
	}
}
