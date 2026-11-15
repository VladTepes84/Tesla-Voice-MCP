package gpscandidate

// Candidate signed transport, gated by the internal proxy. The order
// schema is explicitly experimental. No wake, state read, REST fallback or SDK
// upgrade. A real activation still needs verified schema and route-wide fencing.
import (
	"context"
	"errors"
	"time"

	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"google.golang.org/protobuf/proto"
	"tesla-voice-mcp/nativewaypoints"
)

const ExperimentalOrderSchema = "teslemetry-2c45a2f9-replace0-append2"

type TransportApproval struct {
	Enabled            bool
	ExperimentalSchema string
}

// RunSignedCandidate requires an explicit approval object and a factory. No env
// variable or HTTP input activates it. The caller's acquire callback MUST fence
// all navigation operations for the vehicle and enforce the existing HTTP meter;
// unit/bridge fixture callbacks are not proof of that production integration.
func RunSignedCandidate(parent context.Context, store RouteJournalStore, id string, points []Point, acquire Preflight, factory nativewaypoints.Factory, command nativewaypoints.Command, key protocol.ECDHPrivateKey, approval TransportApproval) (Summary, error) {
	if !approval.Enabled || approval.ExperimentalSchema != ExperimentalOrderSchema {
		return Summary{}, errors.New("GPS candidate transport disabled")
	}
	if acquire == nil || factory == nil {
		return Summary{}, errors.New("GPS candidate transport not configured")
	}
	// Share one bounded context across handshake and every step.
	ctx, cancel := context.WithTimeout(parent, 24*time.Second)
	defer cancel()
	var car nativewaypoints.Vehicle
	preflight := func(ctx context.Context, count int) (func(), error) {
		release, err := acquire(ctx, count)
		if err != nil || release == nil {
			return nil, errors.New("navigation guard or budget unavailable")
		}
		car, err = factory(command, key)
		if err != nil || car == nil {
			release()
			return nil, errors.New("candidate vehicle session unavailable")
		}
		cleanup := func() { car.Disconnect(); release() }
		if car.Connect(ctx) != nil {
			cleanup()
			return nil, errors.New("candidate connection failed")
		}
		if car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT}) != nil {
			cleanup()
			return nil, errors.New("candidate session failed")
		}
		return cleanup, nil
	}
	send := func(ctx context.Context, index int, payload []byte) (StepState, error) {
		// The pinned SDK handles authenticated Infotainment command transmission.
		// SDK's own safe retransmissions remain subject to the existing HTTP meter.
		raw, err := car.Send(ctx, universal.Domain_DOMAIN_INFOTAINMENT, payload, connector.AuthMethodHMAC)
		if err != nil {
			return Unknown, errors.New("candidate command outcome unknown")
		}
		var response carserver.Response
		if proto.Unmarshal(raw, &response) != nil || response.GetActionStatus() == nil {
			return Unknown, nil
		}
		switch response.GetActionStatus().GetResult() {
		case carserver.OperationStatus_E_OPERATIONSTATUS_OK:
			return Accepted, nil
		case carserver.OperationStatus_E_OPERATIONSTATUS_ERROR:
			return Rejected, nil
		default:
			return Unknown, nil
		}
	}
	return RunPrepared(ctx, store, id, points, preflight, send)
}

// RunSignedDiagnosticPayload sends one Replace or Append command through the
// pinned official SDK. A call handles one Vehicle.Send at most and does not
// continue to another journal step.
func RunSignedDiagnosticPayload(parent context.Context, store RouteJournalStore, id, accountScope string, index int, payload []byte, acquire Preflight, factory nativewaypoints.Factory, command nativewaypoints.Command, key protocol.ECDHPrivateKey, approval TransportApproval, beforeCommand func(context.Context) error) (Summary, error) {
	if !approval.Enabled || approval.ExperimentalSchema != ExperimentalOrderSchema || acquire == nil || factory == nil {
		return Summary{}, errors.New("GPS diagnostic transport disabled")
	}
	ctx, cancel := context.WithTimeout(parent, 24*time.Second)
	defer cancel()
	var car nativewaypoints.Vehicle
	preflight := func(ctx context.Context, _ int) (func(), error) {
		release, err := acquire(ctx, 1)
		if err != nil || release == nil {
			return nil, errors.New("navigation guard or budget unavailable")
		}
		car, err = factory(command, key)
		if err != nil || car == nil {
			release()
			return nil, errors.New("diagnostic vehicle session unavailable")
		}
		cleanup := func() { car.Disconnect(); release() }
		if car.Connect(ctx) != nil || car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT}) != nil {
			cleanup()
			return nil, errors.New("diagnostic session connection failed")
		}
		return cleanup, nil
	}
	send := func(ctx context.Context, _ int, payload []byte) (StepState, error) {
		if beforeCommand != nil {
			if err := beforeCommand(ctx); err != nil {
				return Rejected, err
			}
		}
		raw, err := car.Send(ctx, universal.Domain_DOMAIN_INFOTAINMENT, payload, connector.AuthMethodHMAC)
		if err != nil {
			return Unknown, errors.New("diagnostic command outcome unknown")
		}
		var response carserver.Response
		if proto.Unmarshal(raw, &response) != nil || response.GetActionStatus() == nil {
			return Unknown, nil
		}
		switch response.GetActionStatus().GetResult() {
		case carserver.OperationStatus_E_OPERATIONSTATUS_OK:
			return Accepted, nil
		case carserver.OperationStatus_E_OPERATIONSTATUS_ERROR:
			return Rejected, nil
		default:
			return Unknown, nil
		}
	}
	return RunDiagnosticPayload(ctx, store, id, accountScope, index, payload, preflight, send)
}
