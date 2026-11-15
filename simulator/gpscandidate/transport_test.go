package gpscandidate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/teslamotors/vehicle-command/pkg/connector"
	"github.com/teslamotors/vehicle-command/pkg/protocol"
	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	universal "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/universalmessage"
	"google.golang.org/protobuf/proto"
	"tesla-voice-mcp/nativewaypoints"
)

type signedVehicleFixture struct {
	beforeSend func(context.Context, int)

	t                                       *testing.T
	sent, connected, sessions, disconnected int
	guardHeld                               *bool
	handshakeError                          bool
	second                                  string
}

func (v *signedVehicleFixture) Connect(ctx context.Context) error {
	v.connected++
	if v.guardHeld == nil || !*v.guardHeld {
		v.t.Fatal("connection before guard")
	}
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > 24*time.Second {
		v.t.Fatal("missing total budget")
	}
	return nil
}
func (v *signedVehicleFixture) Disconnect() { v.disconnected++ }
func (v *signedVehicleFixture) StartSession(ctx context.Context, domains []universal.Domain) error {
	v.sessions++
	if len(domains) != 1 || domains[0] != universal.Domain_DOMAIN_INFOTAINMENT {
		v.t.Fatal("wrong domain")
	}
	if v.handshakeError {
		return errors.New("fixture handshake failure")
	}
	return nil
}
func (v *signedVehicleFixture) Send(ctx context.Context, d universal.Domain, p []byte, a connector.AuthMethod) ([]byte, error) {
	if !*v.guardHeld || d != universal.Domain_DOMAIN_INFOTAINMENT || a != connector.AuthMethodHMAC {
		v.t.Fatal("unguarded/unsigned send")
	}
	if v.beforeSend != nil {
		v.beforeSend(ctx, v.sent)
	}
	v.sent++
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 10*time.Second {
		v.t.Fatal("missing per-step budget")
	}
	if v.sent == 2 {
		switch v.second {
		case "network":
			return nil, errors.New("fixture secret network detail")
		case "malformed":
			return []byte{255}, nil
		case "empty":
			return nil, nil
		case "reject":
			raw, _ := proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: carserver.OperationStatus_E_OPERATIONSTATUS_ERROR}})
			return raw, nil
		}
	}
	return proto.Marshal(&carserver.Response{ActionStatus: &carserver.ActionStatus{Result: carserver.OperationStatus_E_OPERATIONSTATUS_OK}})
}
func TestSignedCandidateDisabledBeforeAnyStoreOrFactory(t *testing.T) {
	called := false
	factory := func(nativewaypoints.Command, protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
		called = true
		return nil, nil
	}
	for _, approval := range []TransportApproval{{}, {Enabled: true, ExperimentalSchema: "guessed"}} {
		if _, err := RunSignedCandidate(context.Background(), nil, "", nil, nil, factory, nativewaypoints.Command{}, nil, approval); err == nil {
			t.Fatal("unapproved transport")
		}
	}
	if called {
		t.Fatal("factory called while disabled")
	}
}
func TestActualRedisSignedCandidateSessionAndFailureBoundaries(t *testing.T) {
	command := actualRedis(t)
	points := []Point{{45, 9}, {46, 10}, {47, 11}}
	modes := []string{"ok", "handshake", "network", "malformed", "empty", "reject", "budget"}
	for k, mode := range modes {
		t.Run(mode, func(t *testing.T) {
			scope := strings.Repeat(string("abcdef0"[k]), 64)
			store, _ := NewJournalStore(command, scope)
			j, _ := NewJournal(points)
			if err := store.Create(context.Background(), j); err != nil {
				t.Fatal(err)
			}
			held := false
			v := &signedVehicleFixture{t: t, guardHeld: &held, second: mode, handshakeError: mode == "handshake"}
			acquired, released := 0, 0
			acquire := func(context.Context, int) (func(), error) {
				acquired++
				if mode == "budget" {
					return nil, errors.New("fixture denied")
				}
				held = true
				return func() { held = false; released++ }, nil
			}
			factory := func(nativewaypoints.Command, protocol.ECDHPrivateKey) (nativewaypoints.Vehicle, error) {
				if !held {
					t.Fatal("factory before guard")
				}
				return v, nil
			}
			s, err := RunSignedCandidate(context.Background(), store, j.RouteID, points, acquire, factory, nativewaypoints.Command{}, nil, TransportApproval{true, ExperimentalOrderSchema})
			if acquired != 1 || held {
				t.Fatal("lease leak")
			}
			if mode == "ok" {
				if err != nil || v.sent != 3 || !s.AllAPIAccepted || s.VehicleRouteVerified {
					t.Fatal(s, err, v.sent)
				}
			} else {
				if err == nil || s.AllAPIAccepted || s.VehicleRouteVerified {
					t.Fatal("failure became success", s, err)
				}
				if mode == "handshake" || mode == "budget" {
					if v.sent != 0 {
						t.Fatal("sent despite preflight failure")
					}
				} else {
					if v.sent != 2 || s.AcceptedSteps != 1 || !s.Partial || !s.Blocked {
						t.Fatal("continued after unknown/rejected", s, v.sent)
					}
				}
			}
			if mode != "budget" && (released != 1 || v.disconnected != 1) {
				t.Fatal("connection not cleaned up")
			}
			loaded, e := store.Load(context.Background(), j.RouteID)
			if e != nil {
				t.Fatal(e)
			}
			if mode != "ok" {
				if _, _, e := ClaimNext(loaded, loaded.Version); e == nil {
					t.Fatal("failed/uncertain sequence auto-resumed")
				}
			}
		})
	}
}
