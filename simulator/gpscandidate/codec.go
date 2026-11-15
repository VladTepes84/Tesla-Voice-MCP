// Package gpscandidate implements a disabled-by-default coordinate-route candidate.
// The internal proxy imports it behind explicit gates; this codec itself has no I/O.
// Schema evidence: Teslemetry/tesla-protocol commit
// 2c45a2f90a12d1e2e88e8ed01b763345bbc671f4, not an official Tesla SDK contract.
package gpscandidate

import (
	"errors"
	"math"

	"google.golang.org/protobuf/encoding/protowire"
)

type Point struct{ Latitude, Longitude float64 }

// EncodeDiagnosticPoint creates exactly one GPS request action. The diagnostic
// workflow uses Replace for phase A and Append for phase B. Keep the enum values
// aligned with EncodeRoute; these remain experimental and are not a Tesla
// display-verification signal.
func EncodeDiagnosticPoint(point Point, appendToRoute bool) ([]byte, error) {
	if err := ValidatePoint(point); err != nil {
		return nil, err
	}
	return encodePoint(point, appendToRoute), nil
}

func ValidatePoint(p Point) error {
	if math.IsNaN(p.Latitude) || math.IsInf(p.Latitude, 0) || math.IsNaN(p.Longitude) || math.IsInf(p.Longitude, 0) || p.Latitude < -90 || p.Latitude > 90 || p.Longitude < -180 || p.Longitude > 180 {
		return errors.New("invalid coordinate")
	}
	return nil
}

func encodePoint(p Point, appendToRoute bool) []byte {
	var request []byte
	if p.Latitude != 0 {
		request = protowire.AppendTag(request, 1, protowire.Fixed64Type)
		request = protowire.AppendFixed64(request, math.Float64bits(p.Latitude))
	}
	if p.Longitude != 0 {
		request = protowire.AppendTag(request, 2, protowire.Fixed64Type)
		request = protowire.AppendFixed64(request, math.Float64bits(p.Longitude))
	}
	// Candidate schema: Replace=0 (omitted), Prepend=1, Append=2.
	if appendToRoute {
		request = protowire.AppendTag(request, 3, protowire.VarintType)
		request = protowire.AppendVarint(request, 2)
	}
	action := protowire.AppendTag(nil, 53, protowire.BytesType)
	action = protowire.AppendBytes(action, request)
	envelope := protowire.AppendTag(nil, 2, protowire.BytesType)
	return protowire.AppendBytes(envelope, action)
}

// EncodeRoute prepares a candidate replace followed by append payloads. The
// gated runner in request_window.go sends them sequentially through the official
// SDK's signed Vehicle.Send path and journals each result. This is NOT atomic,
// uses an experimental community order schema, and is not display-verified.
func EncodeRoute(points []Point) ([][]byte, error) {
	if len(points) < 2 || len(points) > 16 {
		return nil, errors.New("route requires 2 to 16 points")
	}
	for _, p := range points {
		if math.IsNaN(p.Latitude) || math.IsInf(p.Latitude, 0) || math.IsNaN(p.Longitude) || math.IsInf(p.Longitude, 0) || p.Latitude < -90 || p.Latitude > 90 || p.Longitude < -180 || p.Longitude > 180 {
			return nil, errors.New("invalid coordinate")
		}
	}
	payloads := make([][]byte, len(points))
	for i, p := range points {
		payloads[i] = encodePoint(p, i > 0)
	}
	return payloads, nil
}
