package navigationcontracts

import (
	"context"
	"errors"
	"github.com/teslamotors/vehicle-command/pkg/connector/inet"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
)

// Inspect typed SDK errors only. Never retain or log the original error/body,
// and never infer pairing or authorization failures from arbitrary text.
func failedWithCause(phase string, category, cause error) error {
	f := failed(phase, category).(*Failure)
	f.Reason = "sdk_error"
	for _, known := range []struct {
		err    error
		reason string
	}{
		{context.DeadlineExceeded, "deadline_exceeded"}, {context.Canceled, "cancelled"},
		{protocol.ErrKeyNotPaired, "key_not_paired"}, {protocol.ErrRequiresKey, "signing_key_missing"},
		{protocol.ErrInvalidPublicKey, "invalid_public_key"}, {protocol.ErrUnpexpectedPublicKey, "unexpected_public_key"},
		{inet.ErrVehicleNotAwake, "vehicle_unavailable"}, {protocol.ErrProtocolNotSupported, "protocol_not_supported"},
		{protocol.ErrNotConnected, "not_connected"}, {protocol.ErrNoSession, "no_session"}, {protocol.ErrBadResponse, "bad_response"},
	} {
		if errors.Is(cause, known.err) {
			f.Reason = known.reason
			return f
		}
	}
	var h *inet.HTTPError
	if errors.As(cause, &h) && h.Code >= 100 && h.Code <= 599 {
		f.Reason = "http_error"
		f.HTTPStatus = h.Code
		return f
	}
	var fault *protocol.RoutableMessageError
	if errors.As(cause, &fault) {
		f.Reason = "vehicle_protocol_error"
		if name, ok := universal.MessageFault_E_name[int32(fault.Code)]; ok {
			f.ProtocolFault = name
		} else {
			f.ProtocolFault = "unknown"
		}
	}
	return f
}

func FailureDiagnostic(err error) (reason string, httpStatus int, protocolFault string) {
	var f *Failure
	if errors.As(err, &f) {
		return f.Reason, f.HTTPStatus, f.ProtocolFault
	}
	return "not_available", 0, "none"
}
