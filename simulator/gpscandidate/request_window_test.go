package gpscandidate

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/teslamotors/vehicle-command/pkg/connector/inet"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"github.com/teslamotors/vehicle-command/pkg/vehicle"
	"tesla-voice-mcp/nativewaypoints"
)

type windowHTTPFixture func(*http.Request) (*http.Response, error)

func (f windowHTTPFixture) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func installWindowHTTP(t *testing.T, fn windowHTTPFixture) {
	t.Helper()
	previous := http.DefaultTransport
	http.DefaultTransport = fn
	t.Cleanup(func() { http.DefaultTransport = previous })
}
func fixtureWindowKey(t *testing.T) protocol.ECDHPrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fixture.pem")
	if err = os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: raw}), 0600); err != nil {
		t.Fatal(err)
	}
	parsed, err := protocol.LoadPrivateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
func TestActualSDKHandshakeRetriesCountAgainstSingleWindow(t *testing.T) {
	var posts atomic.Int32
	installWindowHTTP(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "fleet-api.prd.eu.vn.cloud.tesla.com" || !strings.HasSuffix(r.URL.Path, "/signed_command") {
			t.Fatal("unexpected SDK endpoint")
		}
		posts.Add(1)
		return &http.Response{StatusCode: 421, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	inner := inet.NewConnection("5YJ3E1EA0LF000000", "Bearer fixture", "fleet-api.prd.eu.vn.cloud.tesla.com", "fixture")
	window, err := newRequestWindow(ctx, inner, 2)
	if err != nil {
		t.Fatal(err)
	}
	car, err := vehicle.NewVehicle(window, fixtureWindowKey(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer car.Disconnect()
	if err = car.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err = car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT}); err == nil {
		t.Fatal("temporary handshake became success")
	}
	if posts.Load() != 2 || window.Attempts() != 2 {
		t.Fatalf("SDK attempts escaped cap: posts=%d attempts=%d", posts.Load(), window.Attempts())
	}
}

func TestDiagnosticSDKDoesNotRetryTemporarySessionFailure(t *testing.T) {
	var posts atomic.Int32
	installWindowHTTP(t, func(r *http.Request) (*http.Response, error) {
		posts.Add(1)
		return &http.Response{StatusCode: 421, Body: io.NopCloser(strings.NewReader("synthetic safe temporary failure")), Header: make(http.Header)}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	car, err := NewBudgetedDiagnosticVehicle(ctx, nativewaypoints.Command{VIN: "5YJ3E1EA0LF000000", AccessToken: "fixture"}, fixtureWindowKey(t))
	if err != nil {
		t.Fatal(err)
	}
	defer car.Disconnect()
	if err = car.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	err = car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT})
	if err == nil || protocol.ShouldRetry(err) || posts.Load() != 1 {
		t.Fatal("diagnostic SDK session request was retried", err, posts.Load())
	}
}

func TestActualSDKHTTPRespectsEarlierRouteDeadline(t *testing.T) {
	var posts atomic.Int32
	installWindowHTTP(t, func(r *http.Request) (*http.Response, error) {
		posts.Add(1)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	inner := inet.NewConnection("5YJ3E1EA0LF000000", "Bearer fixture", "fleet-api.prd.eu.vn.cloud.tesla.com", "fixture")
	window, err := newRequestWindow(ctx, inner, 4)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	// Simulates the SDK handing the transport an unrelated background context.
	if err = window.Send(context.Background(), []byte("synthetic session request")); err == nil {
		t.Fatal("slow SDK request succeeded")
	}
	if time.Since(started) > time.Second || posts.Load() != 1 {
		t.Fatal("route deadline lost")
	}
	if err = window.Send(context.Background(), nil); err == nil {
		t.Fatal("post-deadline send allowed")
	}
	if posts.Load() != 1 {
		t.Fatal("late send reached HTTP")
	}
}
func TestCandidateWindowCannotIncreaseGlobalLimitOrOmitDeadline(t *testing.T) {
	inner := inet.NewConnection("5YJ3E1EA0LF000000", "Bearer fixture", "fleet-api.prd.eu.vn.cloud.tesla.com", "fixture")
	if _, err := newRequestWindow(context.Background(), inner, 2); err == nil {
		t.Fatal("unbounded context")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := newRequestWindow(ctx, inner, 51); err == nil {
		t.Fatal("more than 50 requests")
	}
}

func TestActualSDKNetworkFailureIsNotAutomaticallyReplayed(t *testing.T) {
	var posts atomic.Int32
	installWindowHTTP(t, func(r *http.Request) (*http.Response, error) {
		posts.Add(1)
		return nil, errors.New("synthetic connection lost after possible write")
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	inner := inet.NewConnection("5YJ3E1EA0LF000000", "Bearer fixture", "fleet-api.prd.eu.vn.cloud.tesla.com", "fixture")
	window, err := newRequestWindow(ctx, inner, 4)
	if err != nil {
		t.Fatal(err)
	}
	car, err := vehicle.NewVehicle(window, fixtureWindowKey(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer car.Disconnect()
	if err = car.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	err = car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT})
	if err == nil || protocol.ShouldRetry(err) || posts.Load() != 1 || window.Attempts() != 1 {
		t.Fatal("ambiguous network failure replayed", err, posts.Load())
	}
}

func TestActualSDKHTTPTimeoutIsNotAutomaticallyReplayed(t *testing.T) {
	var posts atomic.Int32
	installWindowHTTP(t, func(r *http.Request) (*http.Response, error) {
		posts.Add(1)
		return &http.Response{StatusCode: 408, Body: io.NopCloser(strings.NewReader("synthetic timeout after possible write")), Header: make(http.Header)}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	inner := inet.NewConnection("5YJ3E1EA0LF000000", "Bearer fixture", "fleet-api.prd.eu.vn.cloud.tesla.com", "fixture")
	window, err := newRequestWindow(ctx, inner, 4)
	if err != nil {
		t.Fatal(err)
	}
	car, err := vehicle.NewVehicle(window, fixtureWindowKey(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer car.Disconnect()
	if err = car.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	err = car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT})
	if err == nil || protocol.ShouldRetry(err) || posts.Load() != 1 {
		t.Fatal("ambiguous HTTP408 replayed", err, posts.Load())
	}
}
