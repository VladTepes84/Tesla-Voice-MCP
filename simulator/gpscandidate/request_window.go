package gpscandidate

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/connector/inet"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"github.com/teslamotors/vehicle-command/pkg/vehicle"
	"tesla-voice-mcp/nativewaypoints"
)

// requestWindow bounds every SDK datagram, including session negotiation and
// safe internal retransmissions. The pinned inet connector issues one HTTP POST
// per Send. This is a route-local cap, NOT a replacement/reservation of the
// existing global Redis HTTP meter (which remains authoritative).
type requestWindow struct {
	connector.Connector
	route context.Context
	max   int
	mu    sync.Mutex
	used  int
	noRetry bool
}

func newRequestWindow(ctx context.Context, inner connector.Connector, max int) (*requestWindow, error) {
	if inner == nil || max < 1 || max > 50 {
		return nil, errors.New("invalid candidate request window")
	}
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 24*time.Second {
		return nil, errors.New("candidate deadline missing or too long")
	}
	return &requestWindow{Connector: inner, route: ctx, max: max}, nil
}
func (w *requestWindow) Send(ctx context.Context, payload []byte) error {
	if w.route.Err() != nil || ctx.Err() != nil {
		return protocol.NewError("candidate deadline reached", false, false)
	}
	w.mu.Lock()
	if w.used >= w.max {
		w.mu.Unlock()
		return protocol.NewError("candidate request cap reached", false, false)
	}
	w.used++
	noRetry := w.noRetry
	w.mu.Unlock()
	// Do not trust an SDK-internal background context to retain the route deadline.
	bounded, cancel := context.WithTimeout(w.route, 10*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	err := w.Connector.Send(bounded, payload)
	if err == nil {
		return nil
	}
	if noRetry {
		// Vehicle.Send retries errors classified as temporary and not possibly
		// executed. Diagnostic transport attempts are terminal after one POST,
		// including session setup and the navigation action.
		return protocol.NewError("diagnostic action outcome unknown", true, false)
	}
	// The pinned inet SDK labels generic client.Do network errors as temporary
	// and possible-success=false. After an attempted POST that is insufficient
	// evidence of no effect. Prevent SDK replay of ambiguous network outcomes.
	var httpError *inet.HTTPError
	if errors.As(err, &httpError) {
		// A generic 408 can be a lost acknowledgement, not proof of no effect.
		if httpError.Code != http.StatusRequestTimeout {
			return err
		}
	} else if errors.Is(err, inet.ErrVehicleNotAwake) {
		return err
	}
	return protocol.NewError("candidate transport outcome unknown", true, false)
}
func (w *requestWindow) Attempts() int { w.mu.Lock(); defer w.mu.Unlock(); return w.used }

type diagnosticOneShotVehicle struct {
	nativewaypoints.Vehicle
	window *requestWindow
}

func (v diagnosticOneShotVehicle) Send(ctx context.Context, domain universal.Domain, payload []byte, auth connector.AuthMethod) ([]byte, error) {
	v.window.mu.Lock()
	v.window.noRetry = true
	v.window.mu.Unlock()
	return v.Vehicle.Send(ctx, domain, payload, auth)
}

// NewBudgetedDiagnosticVehicle isolates the two-phase diagnostic from other
// candidate transports. No SDK retries are allowed for session setup or the
// navigation action.
func NewBudgetedDiagnosticVehicle(ctx context.Context, command nativewaypoints.Command, key protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
	inner := inet.NewConnection(command.VIN, "Bearer "+command.AccessToken, "fleet-api.prd.eu.vn.cloud.tesla.com", "TeslaVoiceIntelligence/gps-diagnostic")
	window, err := newRequestWindow(ctx, inner, 4)
	if err != nil {
		return nil, err
	}
	window.noRetry = true
	car, err := vehicle.NewVehicle(window, key, nil)
	if err != nil {
		return nil, err
	}
	return diagnosticOneShotVehicle{Vehicle: car, window: window}, nil
}

// Same global meter, ambiguity handling and deadline for a gated single-action
// native candidate. Existing GPS runner is unchanged.
func NewBudgetedSingleVehicle(ctx context.Context, command nativewaypoints.Command, key protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
	inner := inet.NewConnection(command.VIN, "Bearer "+command.AccessToken, "fleet-api.prd.eu.vn.cloud.tesla.com", "TeslaVoiceIntelligence/native-candidate")
	window, err := newRequestWindow(ctx, inner, 4)
	if err != nil {
		return nil, err
	}
	return vehicle.NewVehicle(window, key, nil)
}

// RunBudgetedSignedCandidate requires the existing process-wide Fleet HTTP
// meter and guard; the internal proxy wires its observed variant behind gates.
// No global transport is replaced here; the official inet connection retains it.
func RunBudgetedSignedCandidate(parent context.Context, store RouteJournalStore, id string, points []Point, acquire Preflight, command nativewaypoints.Command, key protocol.ECDHPrivateKey, approval TransportApproval) (Summary, error) {
	return RunBudgetedSignedCandidateObserved(parent, store, id, points, acquire, command, key, approval, nil)
}

// The observer must verify the held route guard before marking dispatch. It is
// invoked at the Vehicle.Send boundary, never during session negotiation.
func RunBudgetedSignedCandidateObserved(parent context.Context, store RouteJournalStore, id string, points []Point, acquire Preflight, command nativewaypoints.Command, key protocol.ECDHPrivateKey, approval TransportApproval, beforeCommand func(context.Context) error) (Summary, error) {
	if !approval.Enabled || approval.ExperimentalSchema != ExperimentalOrderSchema {
		return Summary{}, errors.New("GPS candidate transport disabled")
	}
	if _, err := EncodeRoute(points); err != nil {
		return Summary{}, err
	}
	ctx, cancel := context.WithTimeout(parent, 24*time.Second)
	defer cancel()
	factory := func(command nativewaypoints.Command, key protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
		inner := inet.NewConnection(command.VIN, "Bearer "+command.AccessToken, "fleet-api.prd.eu.vn.cloud.tesla.com", "TeslaVoiceIntelligence/gps-candidate")
		window, err := newRequestWindow(ctx, inner, len(points)+2)
		if err != nil {
			return nil, err
		}
		car, err := vehicle.NewVehicle(window, key, nil)
		if err != nil {
			return nil, err
		}
		return observedVehicle{Vehicle: car, before: beforeCommand}, nil
	}
	return RunSignedCandidate(ctx, store, id, points, acquire, factory, command, key, approval)
}

type observedVehicle struct {
	nativewaypoints.Vehicle
	before func(context.Context) error
}

func (v observedVehicle) Send(ctx context.Context, domain universal.Domain, payload []byte, auth connector.AuthMethod) ([]byte, error) {
	if v.before != nil {
		if err := v.before(ctx); err != nil {
			return nil, err
		}
	}
	return v.Vehicle.Send(ctx, domain, payload, auth)
}
