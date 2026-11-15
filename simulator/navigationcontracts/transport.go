package navigationcontracts

import (
	"context"
	"errors"
	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"google.golang.org/protobuf/proto"
	"tesla-voice-mcp/nativewaypoints"
	"time"
)

var ErrRejected = errors.New("native candidate rejected")
var ErrUnknown = errors.New("native candidate outcome unknown")
var ErrPreflight = errors.New("native candidate preflight failed")

// Failure carries only an allowlisted phase and public outcome category. Never
// retain SDK error text: it may contain vehicle identifiers or credentials.
type Failure struct {
	Phase         string
	Category      error
	Reason        string
	HTTPStatus    int
	ProtocolFault string
}

func (e *Failure) Error() string { return e.Category.Error() + ": " + e.Phase }
func (e *Failure) Unwrap() error { return e.Category }
func FailurePhase(err error) string {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Phase
	}
	return "unspecified"
}
func failed(phase string, category error) error {
	return &Failure{Phase: phase, Category: category, Reason: "not_available", ProtocolFault: "none"}
}

// RunSingle sends one already-encoded action. Caller must validate gates, IDs,
// durable lifecycle, quota and receipts. The proxy supplies a globally metered,
// bounded SDK factory; guard ownership is checked before session and actuation.
func RunSingle(ctx context.Context, payload []byte, command nativewaypoints.Command, key protocol.ECDHPrivateKey, factory nativewaypoints.Factory, verify, before func(context.Context) error) error {
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > 24*time.Second || ctx.Err() != nil || key == nil || factory == nil || verify == nil || before == nil || len(payload) == 0 {
		return failed("validation", ErrPreflight)
	}
	if verify(ctx) != nil {
		return failed("guard_before_session", ErrPreflight)
	}
	car, err := factory(command, key)
	if err != nil || car == nil {
		return failedWithCause("vehicle_factory", ErrPreflight, err)
	}
	defer car.Disconnect()
	if err := car.Connect(ctx); err != nil {
		return failedWithCause("connect", ErrPreflight, err)
	}
	if err := car.StartSession(ctx, []universal.Domain{universal.Domain_DOMAIN_INFOTAINMENT}); err != nil {
		return failedWithCause("session", ErrPreflight, err)
	}
	if ctx.Err() != nil || before(ctx) != nil {
		return failed("guard_before_dispatch", ErrPreflight)
	}
	raw, err := car.Send(ctx, universal.Domain_DOMAIN_INFOTAINMENT, payload, connector.AuthMethodHMAC)
	if err != nil {
		return failedWithCause("send", ErrUnknown, err)
	}
	var result carserver.Response
	if proto.Unmarshal(raw, &result) != nil || result.GetActionStatus() == nil {
		return failed("response_decode", ErrUnknown)
	}
	switch result.GetActionStatus().GetResult() {
	case carserver.OperationStatus_E_OPERATIONSTATUS_OK:
		return nil
	case carserver.OperationStatus_E_OPERATIONSTATUS_ERROR:
		return failed("vehicle_rejected", ErrRejected)
	default:
		return failed("response_status", ErrUnknown)
	}
}
