package nativewaypoints

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"net/http/httptest"
	"strings"
	"testing"
)

const fixtureWaypoints = "refId:FIXTURE_AAAA,refId:FIXTURE_BBBB,refId:FIXTURE_CCCC"
const alphaBetaWaypoints = "refId:TESTPLACEIDONE00000000001,refId:TESTPLACEIDTWO00000000002"

func assertPayloadContainsWaypoints(t *testing.T, waypoints string) []byte {
	t.Helper()
	payload, err := Payload(waypoints)
	if err != nil {
		t.Fatal(err)
	}
	// Decode wire independently of the helper: Action2 > VehicleAction90 > string1.
	n, typ, k := protowire.ConsumeTag(payload)
	if n != 2 || typ != protowire.BytesType {
		t.Fatal("wrong Action arm")
	}
	outer, z := protowire.ConsumeBytes(payload[k:])
	if z != len(payload)-k {
		t.Fatal("extra actions")
	}
	n, typ, k = protowire.ConsumeTag(outer)
	if n != 90 || typ != protowire.BytesType {
		t.Fatal("wrong native action")
	}
	inner, z := protowire.ConsumeBytes(outer[k:])
	if z != len(outer)-k {
		t.Fatal("extra vehicle actions")
	}
	n, typ, k = protowire.ConsumeTag(inner)
	if n != 1 || typ != protowire.BytesType {
		t.Fatal("wrong waypoint field")
	}
	s, z := protowire.ConsumeString(inner[k:])
	if s != waypoints || z != len(inner)-k {
		t.Fatal("order altered or guessed options added")
	}
	return payload
}

func TestPayloadPreservesAllOrderedStopsInOneAction(t *testing.T) {
	for _, count := range []int{2, 3, 4, 16} {
		stops := make([]string, count)
		for i := range stops {
			stops[i] = "refId:FIXTURE_" + strings.Repeat(string(rune('A'+i)), 4)
		}
		waypoints := strings.Join(stops, ",")
		assertPayloadContainsWaypoints(t, waypoints)
	}
}

func TestFourWaypointsUseOneOrderedHMACDispatch(t *testing.T) {
	waypoints := "refId:FIXTURE_AAAA,refId:FIXTURE_BBBB,refId:FIXTURE_CCCC,refId:FIXTURE_DDDD"
	payload := assertPayloadContainsWaypoints(t, waypoints)
	ok, err := proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: carserver.OperationStatus_E_OPERATIONSTATUS_OK}})
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeVehicle{t: t, reply: ok}
	rec := httptest.NewRecorder()
	forwarded := false
	Serve(rec, httptest.NewRequest("POST", "/", nil), Command{Waypoints: waypoints}, nil, &forwarded, func(command Command, _ protocol.ECDHPrivateKey) (Vehicle, error) {
		if command.Waypoints != waypoints {
			t.Fatal("four-waypoint order changed before dispatch")
		}
		return f, nil
	})
	if rec.Code != 200 || !forwarded || f.sends != 1 || !bytes.Equal(f.sentPayload, payload) {
		t.Fatalf("status=%d forwarded=%v sends=%d payload_matches=%v", rec.Code, forwarded, f.sends, bytes.Equal(f.sentPayload, payload))
	}
	var result map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &result) != nil || result["accepted"] != true || result["completed"] != false || result["waypoint_count"] != float64(4) {
		t.Fatal("response claimed invalid or incomplete acceptance")
	}
}

func TestAlphaToBetaUsesOneOrderedHMACDispatch(t *testing.T) {
	payload := assertPayloadContainsWaypoints(t, alphaBetaWaypoints)
	ok, err := proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: carserver.OperationStatus_E_OPERATIONSTATUS_OK}})
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeVehicle{t: t, reply: ok}
	rec := httptest.NewRecorder()
	forwarded := false
	Serve(rec, httptest.NewRequest("POST", "/", nil), Command{Waypoints: alphaBetaWaypoints}, nil, &forwarded, func(command Command, _ protocol.ECDHPrivateKey) (Vehicle, error) {
		if command.Waypoints != alphaBetaWaypoints {
			t.Fatal("application order changed before dispatch")
		}
		return f, nil
	})
	if rec.Code != 200 || !forwarded || f.sends != 1 || !bytes.Equal(f.sentPayload, payload) {
		t.Fatalf("status=%d forwarded=%v sends=%d payload_matches=%v", rec.Code, forwarded, f.sends, bytes.Equal(f.sentPayload, payload))
	}
	var result map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &result) != nil || result["accepted"] != true || result["completed"] != false || result["waypoint_count"] != float64(2) {
		t.Fatal("response claimed invalid or incomplete acceptance")
	}
}
func TestWaypointValidationDoesNotGuessAddressOrCoordinates(t *testing.T) {
	for _, s := range []string{"", "Milano,Laketown,Hilltown", "45.46,9.19", "refId:short", "refId:FIXTURE_AAAA, refId:FIXTURE_BBBB", strings.Repeat("refId:FIXTURE_AAAA,", 16) + "refId:FIXTURE_BBBB"} {
		if Valid(s) {
			t.Fatal("invalid accepted")
		}
	}
	if !Valid("refId:FIXTURE_AAAA,refId:FIXTURE_BBBB,refId:FIXTURE_AAAA") {
		t.Fatal("round-trip repetition rejected")
	}
}

type fakeVehicle struct {
	t                               *testing.T
	connectErr, sessionErr, sendErr error
	reply                           []byte
	sentPayload                     []byte
	sends, disconnects              int
}

func (f *fakeVehicle) Connect(context.Context) error { return f.connectErr }
func (f *fakeVehicle) Disconnect()                   { f.disconnects++ }
func (f *fakeVehicle) StartSession(_ context.Context, domains []universal.Domain) error {
	if len(domains) != 1 || domains[0] != universal.Domain_DOMAIN_INFOTAINMENT {
		f.t.Fatal("unexpected domains")
	}
	return f.sessionErr
}
func (f *fakeVehicle) Send(ctx context.Context, domain universal.Domain, payload []byte, auth connector.AuthMethod) ([]byte, error) {
	f.sends++
	f.sentPayload = append([]byte(nil), payload...)
	if domain != universal.Domain_DOMAIN_INFOTAINMENT || auth != connector.AuthMethodHMAC {
		f.t.Fatal("unsigned or wrong domain")
	}
	if _, ok := ctx.Deadline(); !ok {
		f.t.Fatal("unbounded request")
	}
	return f.reply, f.sendErr
}
func TestNativeSendRequiresExplicitActionStatusAndNeverFallsBack(t *testing.T) {
	ok, _ := proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: carserver.OperationStatus_E_OPERATIONSTATUS_OK}})
	rejected, _ := proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: carserver.OperationStatus_E_OPERATIONSTATUS_ERROR}})
	for _, tc := range []struct {
		name   string
		reply  []byte
		err    error
		status int
	}{
		{"accepted", ok, nil, 200}, {"rejected", rejected, nil, 409}, {"empty", nil, nil, 502}, {"malformed", []byte{255}, nil, 502}, {"network", nil, errors.New("timeout"), 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeVehicle{t: t, reply: tc.reply, sendErr: tc.err}
			rec := httptest.NewRecorder()
			forwarded := false
			Serve(rec, httptest.NewRequest("POST", "/", nil), Command{Waypoints: fixtureWaypoints}, nil, &forwarded, func(Command, protocol.ECDHPrivateKey) (Vehicle, error) { return f, nil })
			if tc.name == "accepted" {
				var result map[string]any
				if json.Unmarshal(rec.Body.Bytes(), &result) != nil || result["completed"] != false || result["waypoint_count"] != float64(3) {
					t.Fatal("invalid completion claim")
				}
			}
			if rec.Code != tc.status || f.sends != 1 || !forwarded || f.disconnects != 1 {
				t.Fatalf("status=%d sends=%d forwarded=%v", rec.Code, f.sends, forwarded)
			}
		})
	}
}
func TestHandshakeFailureNeverDispatchesAndValidationNeverConnects(t *testing.T) {
	f := &fakeVehicle{t: t, sessionErr: errors.New("session rejected")}
	rec := httptest.NewRecorder()
	forwarded := false
	Serve(rec, httptest.NewRequest("POST", "/", nil), Command{Waypoints: fixtureWaypoints}, nil, &forwarded, func(Command, protocol.ECDHPrivateKey) (Vehicle, error) { return f, nil })
	if forwarded || f.sends != 0 || rec.Code != 503 {
		t.Fatal("session error dispatched")
	}
	Serve(httptest.NewRecorder(), httptest.NewRequest("POST", "/", nil), Command{Waypoints: "unverified address"}, nil, &forwarded, func(Command, protocol.ECDHPrivateKey) (Vehicle, error) {
		t.Fatal("connected on invalid input")
		return nil, nil
	})
}
