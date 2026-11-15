package handler

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"google.golang.org/protobuf/proto"
	"tesla-voice-mcp/gpscandidate"
	"tesla-voice-mcp/nativewaypoints"
	"tesla-voice-mcp/testsupport/redisfixture"
)

func gpsFixtureEnv(t *testing.T) {
	t.Helper()
	for k, v := range map[string]string{"VERCEL_ENV": "production", "APP_ORIGIN": "https://mcp.example.invalid", "TESLA_FLEET_REGION": "eu", "TESLA_DAILY_READ_LIMIT": "50", "TESLA_REAL_RELEASE_APPROVED": "true", "TESLA_BACKEND_ENABLED": "true", "TESLA_READ_ENABLED": "true", "TESLA_COMMANDS_ENABLED": "true", "TESLA_COMMAND_EXECUTION_ENABLED": "true", "TESLA_GPS_ROUTE_CANDIDATE_ENABLED": "true", "TESLA_GPS_ROUTE_ORDER_SCHEMA": gpscandidate.ExperimentalOrderSchema, "TOKEN_STORE_REST_URL": "https://redis.fixture.invalid/", "TOKEN_STORE_REST_TOKEN": "fixture-store", "TOKEN_ENCRYPTION_KEY_BASE64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)), "TOKEN_ENCRYPTON_KEY_BASE64": ""} {
		t.Setenv(k, v)
	}
}
func gpsFixtureEnvelope(t *testing.T) commandEnvelope {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return commandEnvelope{VIN: "5YJ3E1EA0LF000000", Operation: "navigation_gps_request", Arguments: map[string]any{"points": []any{map[string]any{"lat": 45.0, "lon": 9.0}, map[string]any{"lat": 46.0, "lon": 10.0}, map[string]any{"lat": 47.0, "lon": 11.0}}}, AccessToken: "fixture-access", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: raw})), Nonce: strings.Repeat("n", 43), NavigationGuardOwner: strings.Repeat("g", 43), NavigationGuardScope: strings.Repeat("s", 43), RouteDeadlineMillis: time.Now().Add(20 * time.Second).UnixMilli()}
}
func gpsSignedRequest(data []byte, stamp, signature string) *http.Request {
	req := httptest.NewRequest("POST", "https://mcp.example.invalid/api/tesla-command-proxy", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tesla-Command-Time", stamp)
	req.Header.Set("X-Tesla-Command-Signature", signature)
	return req
}
func gpsSign(e commandEnvelope) ([]byte, string, string) {
	data, _ := json.Marshal(e)
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	derive := hmac.New(sha256.New, bytes.Repeat([]byte{7}, 32))
	derive.Write([]byte("tesla-command-proxy-v1"))
	signature := hmac.New(sha256.New, derive.Sum(nil))
	signature.Write([]byte(stamp + "\n"))
	signature.Write(data)
	return data, stamp, base64.RawURLEncoding.EncodeToString(signature.Sum(nil))
}
func installGPSRedisHTTP(t *testing.T, command gpscandidate.RedisCommand) {
	t.Helper()
	previous := http.DefaultTransport
	http.DefaultTransport = wakeTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://redis.fixture.invalid/" || r.Header.Get("Authorization") != "Bearer fixture-store" {
			t.Fatal("handler attempted external/Tesla HTTP")
		}
		var raw []any
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			t.Fatal(err)
		}
		args := make([]string, len(raw))
		for i, v := range raw {
			args[i] = fmt.Sprint(v)
		}
		result, err := command(r.Context(), args...)
		var body []byte
		if err != nil {
			body, _ = json.Marshal(map[string]any{"error": "fixture Redis failure"})
		} else {
			body, _ = json.Marshal(map[string]any{"result": result})
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
}

type gpsHandlerVehicle struct {
	before     func(context.Context) error
	sent       int
	payloads   [][]byte
	failSecond bool
	afterFirst func()
}

func (*gpsHandlerVehicle) Connect(context.Context) error { return nil }
func (*gpsHandlerVehicle) Disconnect()                   {}
func (*gpsHandlerVehicle) StartSession(_ context.Context, domains []universal.Domain) error {
	if len(domains) != 1 || domains[0] != universal.Domain_DOMAIN_INFOTAINMENT {
		return errors.New("wrong domain")
	}
	return nil
}
func (v *gpsHandlerVehicle) Send(ctx context.Context, d universal.Domain, payload []byte, a connector.AuthMethod) ([]byte, error) {
	if d != universal.Domain_DOMAIN_INFOTAINMENT || a != connector.AuthMethodHMAC {
		return nil, errors.New("wrong auth")
	}
	if err := v.before(ctx); err != nil {
		return nil, err
	}
	v.sent++
	v.payloads = append(v.payloads, append([]byte(nil), payload...))
	if v.sent == 1 && v.afterFirst != nil {
		v.afterFirst()
	}
	if v.failSecond && v.sent == 2 {
		return nil, errors.New("fixture lost response")
	}
	return proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: carserver.OperationStatus_E_OPERATIONSTATUS_OK}})
}

func installGPSDiagnosticRunner(t *testing.T, car *gpsHandlerVehicle) {
	t.Helper()
	previous := gpsDiagnosticRunner
	gpsDiagnosticRunner = func(ctx context.Context, store gpscandidate.RouteJournalStore, id, accountScope string, index int, payload []byte, acquire gpscandidate.Preflight, command nativewaypoints.Command, key protocol.ECDHPrivateKey, approval gpscandidate.TransportApproval, before func(context.Context) error) (gpscandidate.Summary, error) {
		car.before = before
		factory := func(nativewaypoints.Command, protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
			if key == nil {
				t.Fatal("handler did not load signing key")
			}
			return car, nil
		}
		return gpscandidate.RunSignedDiagnosticPayload(ctx, store, id, accountScope, index, payload, acquire, factory, command, key, approval, before)
	}
	t.Cleanup(func() { gpsDiagnosticRunner = previous })
}
func installGPSRunner(t *testing.T, car *gpsHandlerVehicle) {
	t.Helper()
	previous := gpsCandidateRunner
	gpsCandidateRunner = func(ctx context.Context, store gpscandidate.RouteJournalStore, id string, points []gpscandidate.Point, acquire gpscandidate.Preflight, command nativewaypoints.Command, key protocol.ECDHPrivateKey, approval gpscandidate.TransportApproval, before func(context.Context) error) (gpscandidate.Summary, error) {
		car.before = before
		factory := func(nativewaypoints.Command, protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
			if key == nil {
				t.Fatal("handler did not load signing key")
			}
			return car, nil
		}
		return gpscandidate.RunSignedCandidate(ctx, store, id, points, acquire, factory, command, key, approval)
	}
	t.Cleanup(func() { gpsCandidateRunner = previous })
}

func diagnosticEnvelope(e commandEnvelope, phase, nonce string) commandEnvelope {
	replaceLat, replaceLon := 45.5499106, 9.0782851
	appendLat, appendLon := 45.4641669, 9.1916121
	e.Operation = "navigation_gps_request"
	e.Nonce = nonce
	e.NavigationGuardScope = ""
	e.GPSDiagnostic = &gpsDiagnosticEnvelope{SessionID: "0123456789abcdef0123456789abcdef", AccountScope: strings.Repeat("a", 64), Phase: phase}
	if phase == "replace" {
		e.Arguments = map[string]any{"points": []any{map[string]any{"lat": replaceLat, "lon": replaceLon}}}
		e.GPSDiagnostic.ExpectedAppend = &gpsDiagnosticPoint{Lat: &appendLat, Lon: &appendLon}
	} else {
		e.Arguments = map[string]any{"points": []any{map[string]any{"lat": appendLat, "lon": appendLon}}}
		e.GPSDiagnostic.DisplayChecked = true
	}
	return e
}

func TestActualRedisGPSDiagnosticHandlerSeparatesReplaceAndAppend(t *testing.T) {
	gpsFixtureEnv(t)
	command := gpscandidate.RedisCommand(redisfixture.Start(t))
	installGPSRedisHTTP(t, command)
	car := &gpsHandlerVehicle{}
	installGPSDiagnosticRunner(t, car)
	base := gpsFixtureEnvelope(t)
	if _, err := command(context.Background(), "SET", gpsNavigationGuardKey(base.VIN, ""), base.NavigationGuardOwner); err != nil {
		t.Fatal(err)
	}
	replace := diagnosticEnvelope(base, "replace", strings.Repeat("r", 43))
	data, stamp, sig := gpsSign(replace)
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != http.StatusOK || car.sent != 1 {
		t.Fatal("Replace did not terminate after exactly one send", response.Code, car.sent, response.Body.String())
	}
	wantReplace, _ := gpscandidate.EncodeDiagnosticPoint(gpscandidate.Point{Latitude: 45.5499106, Longitude: 9.0782851}, false)
	if len(car.payloads) != 1 || !bytes.Equal(car.payloads[0], wantReplace) {
		t.Fatal("Replace payload was not encoded with the existing codec")
	}
	var replaceResult map[string]any
	if json.Unmarshal(response.Body.Bytes(), &replaceResult) != nil || replaceResult["phase"] != "replace" || replaceResult["accepted_stops"] != float64(1) || replaceResult["vehicle_route_verified"] != false {
		t.Fatal("Replace response conflated API acceptance and display verification", replaceResult)
	}
	vehicleScope := sha256.Sum256([]byte("gps-diagnostic-vehicle-v1\n" + base.VIN))
	diagnosticPrefix := "tesla-voice:gps-diagnostic:v1:{" + hex.EncodeToString(vehicleScope[:]) + "}:"
	if guard, err := command(context.Background(), "GET", diagnosticPrefix+"guard"); err != nil || guard != replace.GPSDiagnostic.SessionID {
		t.Fatal("Replace released the active diagnostic fence", guard, err)
	}
	appendEnvelope := diagnosticEnvelope(base, "append", strings.Repeat("s", 43))
	data, stamp, sig = gpsSign(appendEnvelope)
	response = httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != http.StatusOK || car.sent != 2 {
		t.Fatal("Append did not send exactly one additional instruction", response.Code, car.sent, response.Body.String())
	}
	wantAppend, _ := gpscandidate.EncodeDiagnosticPoint(gpscandidate.Point{Latitude: 45.4641669, Longitude: 9.1916121}, true)
	if len(car.payloads) != 2 || !bytes.Equal(car.payloads[1], wantAppend) {
		t.Fatal("Append payload or order changed")
	}
	var appendResult map[string]any
	if json.Unmarshal(response.Body.Bytes(), &appendResult) != nil || appendResult["phase"] != "append" || appendResult["accepted_stops"] != float64(2) || appendResult["vehicle_route_verified"] != false {
		t.Fatal("Append response conflated API acceptance and display verification", appendResult)
	}
	if guard, err := command(context.Background(), "GET", diagnosticPrefix+"guard"); err != nil || guard != nil {
		t.Fatal("completed diagnostic did not release its own guard", guard, err)
	}
	// An independently signed request from another account cannot reuse the
	// session, even when it names the same VIN and destination.
	other := diagnosticEnvelope(base, "append", strings.Repeat("t", 43))
	other.GPSDiagnostic.AccountScope = strings.Repeat("b", 64)
	data, stamp, sig = gpsSign(other)
	response = httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != http.StatusConflict || car.sent != 2 {
		t.Fatal("foreign account reused diagnostic session", response.Code, car.sent)
	}
	duplicate := diagnosticEnvelope(base, "append", strings.Repeat("u", 43))
	data, stamp, sig = gpsSign(duplicate)
	response = httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != http.StatusConflict || car.sent != 2 {
		t.Fatal("duplicate Append was dispatched", response.Code, car.sent)
	}
}

func TestGPSDiagnosticAppendRequiresAStartedReplace(t *testing.T) {
	gpsFixtureEnv(t)
	command := gpscandidate.RedisCommand(redisfixture.Start(t))
	installGPSRedisHTTP(t, command)
	car := &gpsHandlerVehicle{}
	installGPSDiagnosticRunner(t, car)
	e := diagnosticEnvelope(gpsFixtureEnvelope(t), "append", strings.Repeat("v", 43))
	command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), e.NavigationGuardOwner)
	data, stamp, sig := gpsSign(e)
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != http.StatusConflict || car.sent != 0 {
		t.Fatal("Append without a valid Replace session was sent", response.Code, car.sent)
	}
}

func TestGPSHandlerGateSignatureAndDeadlineBeforeIO(t *testing.T) {
	gpsFixtureEnv(t)
	previous := http.DefaultTransport
	http.DefaultTransport = wakeTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("rejected request attempted Redis/Fleet")
		return nil, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	e := gpsFixtureEnvelope(t)
	for _, mode := range []string{"disabled", "wrong_schema", "bad_signature", "expired", "too_long", "wrong_guard", "normal_metadata"} {
		t.Run(mode, func(t *testing.T) {
			candidate := e
			switch mode {
			case "disabled":
				t.Setenv("TESLA_GPS_ROUTE_CANDIDATE_ENABLED", "false")
			case "wrong_schema":
				t.Setenv("TESLA_GPS_ROUTE_ORDER_SCHEMA", "guessed")
			case "expired":
				candidate.RouteDeadlineMillis = time.Now().Add(-time.Second).UnixMilli()
			case "too_long":
				candidate.RouteDeadlineMillis = time.Now().Add(40 * time.Second).UnixMilli()
			case "wrong_guard":
				candidate.NavigationGuardOwner = "wrong"
			case "normal_metadata":
				candidate.Operation = "navigation_request"
				candidate.Arguments = map[string]any{"destination": "Fixture"}
			}
			data, stamp, sig := gpsSign(candidate)
			if mode == "bad_signature" {
				sig = strings.Repeat("a", 43)
			}
			response := httptest.NewRecorder()
			Handler(response, gpsSignedRequest(data, stamp, sig))
			if response.Code != 400 && response.Code != 401 {
				t.Fatal("invalid request accepted", response.Code)
			}
			if mode == "expired" && strings.Contains(response.Body.String(), "definitive_no_effect") {
				t.Fatal("expired replay fabricated no-effect proof")
			}
		})
	}
}

func TestActualRedisGPSHandlerReceiptsAndReplay(t *testing.T) {
	gpsFixtureEnv(t)
	command := gpscandidate.RedisCommand(redisfixture.Start(t))
	installGPSRedisHTTP(t, command)
	car := &gpsHandlerVehicle{failSecond: true}
	installGPSRunner(t, car)
	e := gpsFixtureEnvelope(t)
	if _, err := command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), e.NavigationGuardOwner); err != nil {
		t.Fatal(err)
	}
	data, stamp, sig := gpsSign(e)
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != 502 || car.sent != 2 {
		t.Fatal("partial route not stopped", response.Code, car.sent)
	}
	raw, err := command(context.Background(), "GET", "tesla-voice:v1:command-proxy-receipt:"+e.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]any
	if json.Unmarshal([]byte(raw.(string)), &receipt) != nil || receipt["state"] != "uncertain" || receipt["definitive_no_effect"] != false {
		t.Fatal("partial route falsely failed/acknowledged", receipt)
	}
	replay := httptest.NewRecorder()
	Handler(replay, gpsSignedRequest(data, stamp, sig))
	if replay.Code != 409 || car.sent != 2 {
		t.Fatal("signed replay sent again", replay.Code, car.sent)
	}
	// Even a bogus no-effect receipt cannot release a Go journal that already
	// contains an accepted step. This is synthetic corruption, not Tesla proof.
	forged, _ := json.Marshal(map[string]any{"version": 1, "nonce": e.Nonce, "state": "failed", "definitive_no_effect": true})
	command(context.Background(), "SET", "tesla-voice:v1:command-proxy-receipt:"+e.Nonce, string(forged))
	other := e
	other.Nonce = strings.Repeat("q", 43)
	data, stamp, sig = gpsSign(other)
	blocked := httptest.NewRecorder()
	Handler(blocked, gpsSignedRequest(data, stamp, sig))
	if blocked.Code != 503 || car.sent != 2 {
		t.Fatal("partial Go guard released on false no-effect receipt", blocked.Code, car.sent)
	}

}

func TestActualRedisGPSHandlerMissingGuardCannotDispatch(t *testing.T) {
	gpsFixtureEnv(t)
	command := gpscandidate.RedisCommand(redisfixture.Start(t))
	installGPSRedisHTTP(t, command)
	car := &gpsHandlerVehicle{}
	installGPSRunner(t, car)
	e := gpsFixtureEnvelope(t)
	data, stamp, sig := gpsSign(e)
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != 503 || car.sent != 0 {
		t.Fatal("missing guard permitted send", response.Code, car.sent)
	}
	raw, err := command(context.Background(), "GET", "tesla-voice:v1:command-proxy-receipt:"+e.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	var receipt map[string]any
	json.Unmarshal([]byte(raw.(string)), &receipt)
	if receipt["state"] != "failed" || receipt["definitive_no_effect"] != true {
		t.Fatal("no-dispatch receipt missing")
	}
	// A NEW nonce/action can recover from proven pre-dispatch failure, retaining
	// the original journal and receipt. Never replay the original nonce.
	oldReference := map[string]any{}
	json.Unmarshal(response.Body.Bytes(), &oldReference)
	oldID, _ := oldReference["route_reference"].(string)
	next := e
	next.Nonce = strings.Repeat("z", 43)
	if _, err = command(context.Background(), "SET", gpsNavigationGuardKey(next.VIN, next.NavigationGuardScope), next.NavigationGuardOwner); err != nil {
		t.Fatal(err)
	}
	data, stamp, sig = gpsSign(next)
	success := httptest.NewRecorder()
	Handler(success, gpsSignedRequest(data, stamp, sig))
	if success.Code != 200 || car.sent != 3 {
		t.Fatal("proven no-dispatch guard poisoned new action", success.Code, car.sent)
	}
	scope, scopeErr := gpsRouteJournalScope(e.VIN, e.NavigationGuardScope)
	if scopeErr != nil {
		t.Fatal(scopeErr)
	}
	retained, e2 := command(context.Background(), "GET", "tesla-voice:gps-candidate:v1:{"+scope+"}:"+oldID)
	if e2 != nil || retained == nil {
		t.Fatal("prior route journal deleted", e2)
	}
	retained, e2 = command(context.Background(), "GET", "tesla-voice:v1:command-proxy-receipt:"+e.Nonce)
	if e2 != nil || retained == nil {
		t.Fatal("prior proxy receipt deleted", e2)
	}

}

// Exact Node fixture envelope arrives over stdin, never argv/env/logs. No real
// key/token is accepted by this bridge: synthetic VIN/access token are required.
func TestGPSHandlerMCPFixtureBridge(t *testing.T) {
	if os.Getenv("TESLA_GPS_HANDLER_FIXTURE") != "true" {
		t.Skip("dedicated MCP bridge not requested")
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 40000))
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Body, Stamp, Signature string
		RedisSocket            string
		OrderSchema            string
		FailSecond             bool
	}
	if json.Unmarshal(raw, &input) != nil {
		t.Fatal("invalid fixture input")
	}
	var e commandEnvelope
	if json.Unmarshal([]byte(input.Body), &e) != nil || e.AccessToken != "fixture-access" || e.VIN != "5YJ3E1EA0LF000000" {
		t.Fatal("only synthetic fixture identities allowed")
	}
	gpsFixtureEnv(t)
	if input.OrderSchema != "" {
		t.Setenv("TESLA_GPS_ROUTE_ORDER_SCHEMA", input.OrderSchema)
	}
	if !strings.HasPrefix(input.RedisSocket, os.TempDir()+string(os.PathSeparator)) {
		t.Fatal("only local temporary Redis fixture sockets allowed")
	}
	command := gpscandidate.RedisCommand(redisfixture.Connect(input.RedisSocket))
	installGPSRedisHTTP(t, command)
	car := &gpsHandlerVehicle{failSecond: input.FailSecond}
	installGPSRunner(t, car)
	if owner, err := command(context.Background(), "GET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope)); err != nil || owner != e.NavigationGuardOwner {
		t.Fatal("Node route guard missing in shared Redis")
	}
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest([]byte(input.Body), input.Stamp, input.Signature))
	var body struct {
		Accepted bool                 `json:"accepted"`
		Summary  gpscandidate.Summary `json:"route_summary"`
	}
	if json.Unmarshal(response.Body.Bytes(), &body) != nil {
		t.Fatal("handler did not return JSON")
	}
	var result any
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	out := map[string]any{"Accepted": body.Accepted, "Sent": car.sent, "Summary": body.Summary, "Failure": response.Code != 200, "HTTPCode": response.Code, "Response": result}
	encoded, _ := json.Marshal(out)
	fmt.Println("GPS_ROUTE_FIXTURE_RESULT=" + string(encoded))
}

// Dedicated bridge for the two separately invoked diagnostic phases. Each
// subprocess accepts synthetic identities only and shares the test's isolated
// Redis socket; no external/Tesla transport is reachable.
func TestGPSDiagnosticHandlerMCPFixtureBridge(t *testing.T) {
	if os.Getenv("TESLA_GPS_DIAGNOSTIC_HANDLER_FIXTURE") != "true" {
		t.Skip("dedicated GPS diagnostic bridge not requested")
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 40000))
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Body, Stamp, Signature, RedisSocket string
	}
	if json.Unmarshal(raw, &input) != nil {
		t.Fatal("invalid fixture input")
	}
	var e commandEnvelope
	if json.Unmarshal([]byte(input.Body), &e) != nil || e.AccessToken != "fixture-access" || e.VIN != "5YJ3E1EA0LF000000" || e.GPSDiagnostic == nil {
		t.Fatal("only synthetic GPS diagnostic envelopes allowed")
	}
	gpsFixtureEnv(t)
	if !strings.HasPrefix(input.RedisSocket, os.TempDir()+string(os.PathSeparator)) {
		t.Fatal("only local temporary Redis fixture sockets allowed")
	}
	command := gpscandidate.RedisCommand(redisfixture.Connect(input.RedisSocket))
	installGPSRedisHTTP(t, command)
	car := &gpsHandlerVehicle{}
	installGPSDiagnosticRunner(t, car)
	if owner, err := command(context.Background(), "GET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope)); err != nil || owner != e.NavigationGuardOwner {
		t.Fatal("Node diagnostic navigation guard missing in shared Redis")
	}
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest([]byte(input.Body), input.Stamp, input.Signature))
	var body any
	if json.Unmarshal(response.Body.Bytes(), &body) != nil {
		t.Fatal("handler did not return JSON")
	}
	payloads := make([]string, len(car.payloads))
	for i, payload := range car.payloads {
		payloads[i] = hex.EncodeToString(payload)
	}
	encoded, _ := json.Marshal(map[string]any{"Sent": car.sent, "Payloads": payloads, "HTTPCode": response.Code, "Response": body})
	fmt.Println("GPS_DIAGNOSTIC_FIXTURE_RESULT=" + string(encoded))
}

func TestActualRedisGPSHandlerStopsWhenGuardOwnerChanges(t *testing.T) {
	gpsFixtureEnv(t)
	command := gpscandidate.RedisCommand(redisfixture.Start(t))
	installGPSRedisHTTP(t, command)
	e := gpsFixtureEnvelope(t)
	command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), e.NavigationGuardOwner)
	car := &gpsHandlerVehicle{afterFirst: func() { command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), strings.Repeat("x", 43)) }}
	installGPSRunner(t, car)
	data, stamp, sig := gpsSign(e)
	response := httptest.NewRecorder()
	Handler(response, gpsSignedRequest(data, stamp, sig))
	if response.Code != 502 || car.sent != 1 {
		t.Fatal("stale owner sent another stop", response.Code, car.sent)
	}
	var body struct {
		Evidence map[string]any       `json:"command_evidence"`
		Summary  gpscandidate.Summary `json:"route_summary"`
	}
	json.Unmarshal(response.Body.Bytes(), &body)
	if body.Evidence["state"] != "uncertain" || body.Evidence["definitive_no_effect"] != false || body.Summary.AcceptedSteps != 1 {
		t.Fatal("partial ownership loss misclassified")
	}
}

func TestActualRedisGPSHandlerSDKHTTPUsesProductionUnlimitedMeter(t *testing.T) {
	for _, used := range []int{0, 48} {
		t.Run(strconv.Itoa(used), func(t *testing.T) {
			gpsFixtureEnv(t)
			command := gpscandidate.RedisCommand(redisfixture.Start(t))
			e := gpsFixtureEnvelope(t)
			command(context.Background(), "SET", gpsNavigationGuardKey(e.VIN, e.NavigationGuardScope), e.NavigationGuardOwner)
			day := time.Now().UTC().Format("2006-01-02")
			for i := 0; i < used; i++ {
				command(context.Background(), "SET", fmt.Sprintf("tesla-voice:v1:read-budget:%s:%d", day, i), "1", "EX", "172800")
			}
			posts := 0
			base := wakeTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.String() == "https://redis.fixture.invalid/" {
					var raw []any
					if json.NewDecoder(r.Body).Decode(&raw) != nil {
						t.Fatal("bad Redis envelope")
					}
					args := make([]string, len(raw))
					for i, v := range raw {
						args[i] = fmt.Sprint(v)
					}
					result, err := command(r.Context(), args...)
					var data []byte
					if err != nil {
						data, _ = json.Marshal(map[string]any{"error": "fixture Redis error"})
					} else {
						data, _ = json.Marshal(map[string]any{"result": result})
					}
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data))}, nil
				}
				if r.URL.Host != "fleet-api.prd.eu.vn.cloud.tesla.com" || !strings.HasSuffix(r.URL.Path, "/signed_command") {
					t.Fatal("unexpected external request")
				}
				posts++
				return &http.Response{StatusCode: 421, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("synthetic temporary response"))}, nil
			})
			previous := http.DefaultTransport
			http.DefaultTransport = fleetBudgetTransport{base: base, reserve: func(ctx context.Context) error { return reserveFleetHTTPRequest(ctx, base, time.Now()) }}
			t.Cleanup(func() { http.DefaultTransport = previous })
			// No runner injection: the REAL pinned SDK executes handshake attempts, but
			// every HTTP exchange terminates in the in-process fake RoundTripper above.
			runner := gpsCandidateRunner
			gpsCandidateRunner = gpscandidate.RunBudgetedSignedCandidateObserved
			t.Cleanup(func() { gpsCandidateRunner = runner })
			data, stamp, sig := gpsSign(e)
			response := httptest.NewRecorder()
			Handler(response, gpsSignedRequest(data, stamp, sig))
			expected := 5
			if response.Code != 503 || posts != expected {
				t.Fatal("SDK requests escaped quota/cap", response.Code, posts, expected)
			}
			var body struct {
				Evidence map[string]any `json:"command_evidence"`
			}
			json.Unmarshal(response.Body.Bytes(), &body)
			if body.Evidence["state"] != "failed" || body.Evidence["definitive_no_effect"] != true {
				t.Fatal("handshake-only failure not distinguished")
			}
			count := 0
			for i := 0; i < 50; i++ {
				value, err := command(context.Background(), "GET", fmt.Sprintf("tesla-voice:v1:read-budget:%s:%d", day, i))
				if err != nil {
					t.Fatal(err)
				}
				if value == "1" {
					count++
				}
			}
			if count != used {
				t.Fatal("legacy Redis slot count mismatch", count, used)
			}
			extra, err := command(context.Background(), "GET", fmt.Sprintf("tesla-voice:v1:read-budget-extra:%s", day))
			if err != nil || extra != fmt.Sprint(expected) {
				t.Fatal("actual Redis unlimited meter count mismatch", extra, err, expected)
			}
		})
	}
}
