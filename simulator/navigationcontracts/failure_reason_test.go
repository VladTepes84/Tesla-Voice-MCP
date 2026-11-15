package navigationcontracts

import (
	"context"
	"errors"
	"fmt"
	"github.com/teslamotors/vehicle-command/pkg/connector/inet"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"testing"
)

func TestFailureReasonsUseTypedSDKSignalsWithoutLeakingCause(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		reason string
		status int
		fault  string
	}{
		{"pairing", protocol.ErrKeyNotPaired, "key_not_paired", 0, "none"},
		{"missing_key", protocol.ErrRequiresKey, "signing_key_missing", 0, "none"},
		{"public_key", protocol.ErrInvalidPublicKey, "invalid_public_key", 0, "none"},
		{"key_changed", protocol.ErrUnpexpectedPublicKey, "unexpected_public_key", 0, "none"},
		{"asleep", inet.ErrVehicleNotAwake, "vehicle_unavailable", 0, "none"},
		{"unsupported", protocol.ErrProtocolNotSupported, "protocol_not_supported", 0, "none"},
		{"deadline", context.DeadlineExceeded, "deadline_exceeded", 0, "none"},
		{"cancelled", context.Canceled, "cancelled", 0, "none"},
		{"not_connected", protocol.ErrNotConnected, "not_connected", 0, "none"},
		{"no_session", protocol.ErrNoSession, "no_session", 0, "none"},
		{"bad_response", protocol.ErrBadResponse, "bad_response", 0, "none"},
		{"unauthorized", &inet.HTTPError{Code: 401, Message: "secret-token VIN"}, "http_error", 401, "none"},
		{"forbidden", &inet.HTTPError{Code: 403, Message: "secret-token VIN"}, "http_error", 403, "none"},
		{"invalid_status", &inet.HTTPError{Code: 999999, Message: "secret-token VIN"}, "sdk_error", 0, "none"},
		{"fault", &protocol.RoutableMessageError{Code: universal.MessageFault_E_MESSAGEFAULT_ERROR_INVALID_SIGNATURE}, "vehicle_protocol_error", 0, "MESSAGEFAULT_ERROR_INVALID_SIGNATURE"},
		{"unknown_fault", &protocol.RoutableMessageError{Code: 999999}, "vehicle_protocol_error", 0, "unknown"},
		{"untrusted_text", errors.New("key not paired http 403 secret-token VIN"), "sdk_error", 0, "none"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, category := range []error{ErrPreflight, ErrUnknown} {
				err := failedWithCause("session", category, fmt.Errorf("secret-token VIN: %w", tc.err))
				reason, status, fault := FailureDiagnostic(err)
				if reason != tc.reason || status != tc.status || fault != tc.fault {
					t.Fatalf("classification mismatch: %s %d %s", reason, status, fault)
				}
				if !errors.Is(err, category) || errors.Unwrap(err) != category {
					t.Fatal("outcome category changed or raw cause retained")
				}
				if err.Error() != category.Error()+": session" {
					t.Fatal("unsafe error text")
				}
			}
		})
	}
}
