package nativewaypoints

// Candidate adapter from the maintainer-reviewed layout in Tesla PR443,
// head 281b3a70caaef258e2f7dfe0136a2a192b8cb017. NOT merged or vehicle-validated.
// Default gate off. No SDK fork, unsigned REST fallback or single-stop sequence.
import (
	"context"
	"encoding/json"
	"errors"
	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/connector/inet"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"github.com/teslamotors/vehicle-command/pkg/vehicle"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type Command struct{ VIN, AccessToken, Waypoints string }

func replyError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

var nativeWaypointToken = regexp.MustCompile(`^refId:[A-Za-z0-9_-]{8,128}$`)

func Valid(value string) bool {
	if len(value) > 2048 {
		return false
	}
	parts := strings.Split(value, ",")
	if len(parts) < 2 || len(parts) > 16 {
		return false
	}
	for _, part := range parts {
		if !nativeWaypointToken.MatchString(part) {
			return false
		}
	}
	return true
}
func Payload(value string) ([]byte, error) {
	if !Valid(value) {
		return nil, errors.New("invalid waypoints")
	}
	msg := protowire.AppendTag(nil, 1, protowire.BytesType)
	msg = protowire.AppendString(msg, value)
	extension := protowire.AppendTag(nil, 90, protowire.BytesType)
	extension = protowire.AppendBytes(extension, msg)
	action := &carserver.VehicleAction{}
	action.ProtoReflect().SetUnknown(extension)
	return proto.Marshal(&carserver.Action{ActionMsg: &carserver.Action_VehicleAction{VehicleAction: action}})
}

type Vehicle interface {
	Connect(context.Context) error
	Disconnect()
	StartSession(context.Context, []universal.Domain) error
	Send(context.Context, universal.Domain, []byte, connector.AuthMethod) ([]byte, error)
}
type Factory func(Command, protocol.ECDHPrivateKey) (Vehicle, error)

func NewVehicle(e Command, key protocol.ECDHPrivateKey) (Vehicle, error) {
	// Same pinned region, token, key and globally metered HTTP transport.
	conn := inet.NewConnection(e.VIN, "Bearer "+e.AccessToken, "fleet-api.prd.eu.vn.cloud.tesla.com", "TeslaVoiceIntelligence/native-waypoints")
	return vehicle.NewVehicle(conn, key, nil)
}
func responseResult(payload []byte) string {
	var response carserver.Response
	if proto.Unmarshal(payload, &response) != nil || response.GetActionStatus() == nil {
		return "command_outcome_unknown"
	}
	switch response.GetActionStatus().GetResult() {
	case carserver.OperationStatus_E_OPERATIONSTATUS_OK:
		return ""
	case carserver.OperationStatus_E_OPERATIONSTATUS_ERROR:
		return "command_rejected"
	default:
		return "command_outcome_unknown"
	}
}
func Serve(w http.ResponseWriter, r *http.Request, e Command, key protocol.ECDHPrivateKey, forwarded *bool, factory Factory) {
	value := e.Waypoints
	payload, err := Payload(value)
	if err != nil {
		replyError(w, http.StatusBadRequest, "invalid_command")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	car, err := factory(e, key)
	if err != nil {
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	defer car.Disconnect()
	if car.Connect(ctx) != nil {
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	// Infotainment handshake only: no wake, GPS, state read or REST fallback.
	if car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT}) != nil {
		replyError(w, http.StatusServiceUnavailable, "command_upstream_unavailable")
		return
	}
	*forwarded = true
	reply, err := car.Send(ctx, universal.Domain_DOMAIN_INFOTAINMENT, payload, connector.AuthMethodHMAC)
	// SDK retries only definitely-not-executed temporary failures within ctx.
	// This adapter never retries or replaces an uncertain command.
	if err != nil {
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	switch responseResult(reply) {
	case "command_rejected":
		replyError(w, http.StatusConflict, "command_rejected")
		return
	case "command_outcome_unknown":
		replyError(w, http.StatusBadGateway, "command_outcome_unknown")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true, "completed": false, "navigation_mode": "native_waypoints", "waypoint_count": len(strings.Split(value, ","))})
}
