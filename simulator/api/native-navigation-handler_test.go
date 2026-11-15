package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"tesla-voice-mcp/gpscandidate"
	"tesla-voice-mcp/nativewaypoints"
	"tesla-voice-mcp/navigationcontracts"
	"tesla-voice-mcp/testsupport/redisfixture"
	"testing"
	"time"
)

func nativeFixtureEnv(t *testing.T) {
	gpsFixtureEnv(t)
	t.Setenv("TESLA_NATIVE_COORDINATE_ENABLED", "true")
	t.Setenv("TESLA_NATIVE_COORDINATE_PILOT_ENABLED", "true")
	t.Setenv("TESLA_NATIVE_COORDINATE_SCHEMA", navigationcontracts.CoordinateBatchSchema)
	t.Setenv("TESLA_NATIVE_SUPERCHARGER_ENABLED", "true")
	t.Setenv("TESLA_NATIVE_SUPERCHARGER_SCHEMA", navigationcontracts.SuperchargerSchema)
	t.Setenv("TESLA_NATIVE_WAYPOINTS_ENABLED", "false")
}
func nativeFixtureEnvelope(t *testing.T, sc bool) commandEnvelope {
	e := gpsFixtureEnvelope(t)
	e.Operation = "navigation_waypoints_request"
	e.Arguments = map[string]any{"waypoints": "45,9;46,10;45,9"}
	if sc {
		e.Operation = "navigation_sc_request"
		e.Arguments = map[string]any{"site_id": "9223372036854775807"}
	}
	return e
}

type nativeHandlerVehicle struct {
	sent              int
	lost              bool
	reject            bool
	afterSession      func()
	expectedWaypoints string
}

func (*nativeHandlerVehicle) Connect(context.Context) error { return nil }
func (*nativeHandlerVehicle) Disconnect()                   {}
func (v *nativeHandlerVehicle) StartSession(_ context.Context, d []universal.Domain) error {
	if len(d) != 1 || d[0] != universal.Domain_DOMAIN_INFOTAINMENT {
		return errors.New("wrong domain")
	}
	if v.afterSession != nil {
		v.afterSession()
	}
	return nil
}
func (v *nativeHandlerVehicle) Send(ctx context.Context, d universal.Domain, p []byte, a connector.AuthMethod) ([]byte, error) {
	if ctx.Err() != nil || d != universal.Domain_DOMAIN_INFOTAINMENT || a != connector.AuthMethodHMAC {
		return nil, errors.New("wrong transport")
	}
	var action carserver.Action
	if proto.Unmarshal(p, &action) != nil || action.GetVehicleAction() == nil {
		return nil, errors.New("bad action")
	}
	raw := action.GetVehicleAction().ProtoReflect().GetUnknown()
	n, typ, k := protowire.ConsumeTag(raw)
	if (n != 22 && n != 90) || typ != protowire.BytesType {
		return nil, errors.New("wrong native action")
	}
	actionBytes, z := protowire.ConsumeBytes(raw[k:])
	if z != len(raw)-k {
		return nil, errors.New("multiple actions")
	}
	if v.expectedWaypoints != "" {
		if n != 90 {
			return nil, errors.New("not a waypoint action")
		}
		field, wireType, offset := protowire.ConsumeTag(actionBytes)
		if field != 1 || wireType != protowire.BytesType {
			return nil, errors.New("wrong waypoint field")
		}
		got, consumed := protowire.ConsumeString(actionBytes[offset:])
		if consumed != len(actionBytes)-offset || got != v.expectedWaypoints {
			return nil, errors.New("waypoint order or payload changed")
		}
	}
	v.sent++
	if v.lost {
		return nil, errors.New("synthetic lost response")
	}
	status := carserver.OperationStatus_E_OPERATIONSTATUS_OK
	if v.reject {
		status = carserver.OperationStatus_E_OPERATIONSTATUS_ERROR
	}
	return proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: status}})
}
func installNativeFactory(t *testing.T, car *nativeHandlerVehicle) {
	t.Helper()
	previous := nativeCandidateFactory
	nativeCandidateFactory = func(_ context.Context, _ nativewaypoints.Command, key protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
		if key == nil {
			t.Fatal("missing signing key")
		}
		return car, nil
	}
	t.Cleanup(func() { nativeCandidateFactory = previous })
}

func inMemoryNativeCommandStore() gpscandidate.RedisCommand {
	var mu sync.Mutex
	values := map[string]string{}
	return func(ctx context.Context, args ...string) (any, error) {
		if ctx.Err() != nil || len(args) < 2 {
			return nil, errors.New("invalid fixture store request")
		}
		mu.Lock()
		defer mu.Unlock()
		switch args[0] {
		case "GET":
			value, ok := values[args[1]]
			if !ok {
				return nil, nil
			}
			return value, nil
		case "SET":
			if len(args) < 3 {
				return nil, errors.New("invalid fixture store write")
			}
			for _, option := range args[3:] {
				if option == "NX" {
					if _, exists := values[args[1]]; exists {
						return nil, nil
					}
				}
			}
			values[args[1]] = args[2]
			return "OK", nil
		default:
			return nil, errors.New("unexpected fixture store command")
		}
	}
}

func TestNativeGatesAndSignatureRejectBeforeIO(t *testing.T) {
	for _, sc := range []bool{false, true} {
		for _, mode := range []string{"off", "schema", "signature", "expired"} {
			t.Run(fmt.Sprint(sc, mode), func(t *testing.T) {
				nativeFixtureEnv(t)
				e := nativeFixtureEnvelope(t, sc)
				if mode == "off" {
					t.Setenv("TESLA_NATIVE_COORDINATE_ENABLED", "false")
					t.Setenv("TESLA_NATIVE_SUPERCHARGER_ENABLED", "false")
				}
				if mode == "schema" {
					t.Setenv("TESLA_NATIVE_COORDINATE_SCHEMA", "unknown")
					t.Setenv("TESLA_NATIVE_SUPERCHARGER_SCHEMA", "unknown")
				}
				if mode == "expired" {
					e.RouteDeadlineMillis = 1
				}
				prior := http.DefaultTransport
				http.DefaultTransport = wakeTransport(func(*http.Request) (*http.Response, error) {
					t.Fatal("rejected native request reached storage/Fleet")
					return nil, nil
				})
				t.Cleanup(func() { http.DefaultTransport = prior })
				b, sigTime, sig := gpsSign(e)
				if mode == "signature" {
					sig = "bad"
				}
				r := httptest.NewRecorder()
				Handler(r, gpsSignedRequest(b, sigTime, sig))
				if r.Code == 200 {
					t.Fatal("gate bypass")
				}
			})
		}
	}
}

func TestNativeCoordinatesRequireNewPilotGateEvenWhenOldFlagIsTrue(t *testing.T) {
	nativeFixtureEnv(t)
	t.Setenv("TESLA_NATIVE_COORDINATE_PILOT_ENABLED", "false")
	e := nativeFixtureEnvelope(t, false)
	previous := http.DefaultTransport
	http.DefaultTransport = wakeTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("coordinate candidate without pilot gate reached storage/Fleet")
		return nil, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	b, stamp, sig := gpsSign(e)
	r := httptest.NewRecorder()
	Handler(r, gpsSignedRequest(b, stamp, sig))
	if r.Code == 200 {
		t.Fatal("old coordinate flag activated candidate without the new pilot gate")
	}
}

func TestNativeGuardRecheckedAfterHandshake(t *testing.T) {
	nativeFixtureEnv(t)
	command := inMemoryNativeCommandStore()
	installGPSRedisHTTP(t, command)
	e := nativeFixtureEnvelope(t, false)
	command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), e.NavigationGuardOwner)
	car := &nativeHandlerVehicle{afterSession: func() { command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), strings.Repeat("x", 43)) }}
	installNativeFactory(t, car)
	b, stamp, sig := gpsSign(e)
	r := httptest.NewRecorder()
	Handler(r, gpsSignedRequest(b, stamp, sig))
	if r.Code != 503 || car.sent != 0 {
		t.Fatal("lost guard allowed native actuation", r.Code, car.sent)
	}
}

func TestNativeRefIdHandlerUsesOneFencedSignedDispatchInOrder(t *testing.T) {
	nativeFixtureEnv(t)
	t.Setenv("TESLA_NATIVE_WAYPOINTS_ENABLED", "true")
	command := inMemoryNativeCommandStore()
	installGPSRedisHTTP(t, command)
	e := gpsFixtureEnvelope(t)
	e.Operation = "navigation_waypoints_request"
	expected := "refId:FIXTURE_AAAA,refId:FIXTURE_BBBB"
	e.Arguments = map[string]any{"waypoints": expected}
	if _, err := command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), e.NavigationGuardOwner); err != nil {
		t.Fatal(err)
	}
	car := &nativeHandlerVehicle{expectedWaypoints: expected}
	installNativeFactory(t, car)
	body, stamp, signature := gpsSign(e)
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest(body, stamp, signature))
	if response.Code != http.StatusOK || car.sent != 1 {
		t.Fatalf("one ordered HMAC dispatch expected; status=%d sends=%d body=%s", response.Code, car.sent, response.Body.String())
	}
	var result map[string]any
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || result["navigation_mode"] != "experimental_native_refid_waypoints" || result["requested_destinations"] != float64(2) || result["vehicle_route_verified"] != false {
		t.Fatalf("unexpected completion claims: %s", response.Body.String())
	}
	// A replay of the same signed envelope is rejected by the nonce ledger and
	// cannot invoke the command sender a second time.
	replay := httptest.NewRecorder()
	Handler(replay, gpsSignedRequest(body, stamp, signature))
	if replay.Code != http.StatusConflict || car.sent != 1 {
		t.Fatalf("duplicate reached vehicle sender; status=%d sends=%d", replay.Code, car.sent)
	}
}

// Generated Node fixture envelope is passed unchanged via stdin, never argv.
func TestNativeHandlerMCPFixtureBridge(t *testing.T) {
	if os.Getenv("TESLA_NATIVE_HANDLER_FIXTURE") != "true" {
		t.Skip("dedicated fixture bridge only")
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 40000))
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Body, Stamp, Signature, RedisSocket string
		Lost                                bool
		Reject                              bool
	}
	if json.Unmarshal(raw, &input) != nil {
		t.Fatal("bad fixture input")
	}
	var e commandEnvelope
	if json.Unmarshal([]byte(input.Body), &e) != nil || e.VIN != "5YJ3E1EA0LF000000" || e.AccessToken != "fixture-access" {
		t.Fatal("synthetic fixture only")
	}
	if !strings.HasPrefix(input.RedisSocket, os.TempDir()+string(os.PathSeparator)) {
		t.Fatal("local Redis only")
	}
	nativeFixtureEnv(t)
	command := gpscandidate.RedisCommand(redisfixture.Connect(input.RedisSocket))
	installGPSRedisHTTP(t, command)
	if v, err := command(context.Background(), "GET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope)); err != nil || v != e.NavigationGuardOwner {
		t.Fatal("original Node guard missing")
	}
	car := &nativeHandlerVehicle{lost: input.Lost, reject: input.Reject}
	installNativeFactory(t, car)
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest([]byte(input.Body), input.Stamp, input.Signature))
	var body any
	if json.Unmarshal(response.Body.Bytes(), &body) != nil {
		t.Fatal("bad JSON")
	}
	out, _ := json.Marshal(map[string]any{"HTTPCode": response.Code, "Sent": car.sent, "Response": body})
	fmt.Println("NATIVE_FIXTURE_RESULT=" + string(out))
}

func TestNativeActualSDKStillCountsEveryHTTPWithoutDailyCap(t *testing.T) {
	for _, used := range []int{0, 48} {
		t.Run(fmt.Sprint(used), func(t *testing.T) {
			nativeFixtureEnv(t)
			command := gpscandidate.RedisCommand(redisfixture.Start(t))
			e := nativeFixtureEnvelope(t, true)
			command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), e.NavigationGuardOwner)
			stampDay := time.Now().UTC().Format("2006-01-02")
			for i := 0; i < used; i++ {
				command(context.Background(), "SET", fmt.Sprintf("tesla-voice:v1:read-budget:%s:%d", stampDay, i), "1", "EX", "172800")
			}
			posts := 0
			prior := http.DefaultTransport
			base := wakeTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.String() == "https://redis.fixture.invalid/" {
					var raw []any
					json.NewDecoder(r.Body).Decode(&raw)
					args := make([]string, len(raw))
					for i, v := range raw {
						args[i] = fmt.Sprint(v)
					}
					v, err := command(r.Context(), args...)
					if err != nil {
						t.Fatal(err)
					}
					data, _ := json.Marshal(map[string]any{"result": v})
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data))}, nil
				}
				if r.URL.Host != "fleet-api.prd.eu.vn.cloud.tesla.com" || !strings.HasSuffix(r.URL.Path, "/signed_command") {
					t.Fatal("external HTTP")
				}
				posts++
				return &http.Response{StatusCode: 421, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("synthetic retry"))}, nil
			})
			http.DefaultTransport = fleetBudgetTransport{base: base, reserve: func(ctx context.Context) error { return reserveFleetHTTPRequest(ctx, base, time.Now()) }}
			t.Cleanup(func() { http.DefaultTransport = prior })
			b, stamp, sig := gpsSign(e)
			r := httptest.NewRecorder()
			Handler(r, gpsSignedRequest(b, stamp, sig))
			expected := 4
			if r.Code != 503 || posts != expected {
				t.Fatal("native SDK HTTP cap or failure state changed", r.Code, posts)
			}
			count := 0
			for i := 0; i < 50; i++ {
				v, err := command(context.Background(), "GET", fmt.Sprintf("tesla-voice:v1:read-budget:%s:%d", stampDay, i))
				if err != nil {
					t.Fatal(err)
				}
				if v == "1" {
					count++
				}
			}
			extra, err := command(context.Background(), "GET", fmt.Sprintf("tesla-voice:v1:read-budget-extra:%s", stampDay))
			if err != nil || extra != fmt.Sprint(expected) || count != used {
				t.Fatal("daily meter lost requests", count, used, extra, err)
			}
		})
	}
}
