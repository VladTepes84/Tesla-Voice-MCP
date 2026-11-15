// Package navigationcontracts contains explicitly gated experimental encoders
// and a bounded single-command transport. Runtime authorization remains in the handler.
package navigationcontracts

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"

	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

const CoordinateBatchSchema = "experimental-field90-coordinate-string-python-14912c8"
const SuperchargerSchema = "experimental-field22-id1-replace0-teslemetry-2c45a2f9"

type Point struct{ Latitude, Longitude float64 }

var decimal = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-]?[0-9]+)?$`)

func ParseCoordinateString(value string) ([]Point, error) {
	if len(value) > 2048 {
		return nil, errors.New("coordinate string too long")
	}
	rows := strings.Split(value, ";")
	if len(rows) < 2 || len(rows) > 16 {
		return nil, errors.New("invalid coordinate count")
	}
	points := make([]Point, len(rows))
	for i, row := range rows {
		p := strings.Split(row, ",")
		if len(p) != 2 || !decimal.MatchString(p[0]) || !decimal.MatchString(p[1]) {
			return nil, errors.New("invalid coordinate")
		}
		lat, e := strconv.ParseFloat(p[0], 64)
		if e != nil {
			return nil, e
		}
		lon, e := strconv.ParseFloat(p[1], 64)
		if e != nil {
			return nil, e
		}
		points[i] = Point{lat, lon}
	}
	if _, e := EncodeCoordinateBatchCandidate(points, CoordinateBatchSchema); e != nil {
		return nil, e
	}
	return points, nil
}

// EncodeCoordinateBatchCandidate produces ONE Action carrying the entire list.
// Evidence: Tesla PR443's field90/string1 and the coordinate string used in
// python-tesla-fleet-api 14912c8733b16560bcaec7f50861d4c3ea3ed1f8 tests.
// The latter is mocked BLE/author-reported ACK evidence, NOT Fleet/display proof.
func EncodeCoordinateBatchCandidate(points []Point, schema string) ([]byte, error) {
	if schema != CoordinateBatchSchema {
		return nil, errors.New("coordinate batch schema not explicitly selected")
	}
	if len(points) < 2 || len(points) > 16 {
		return nil, errors.New("route requires 2 to 16 destinations")
	}
	rows := make([]string, len(points))
	for i, p := range points {
		if math.IsNaN(p.Latitude) || math.IsInf(p.Latitude, 0) || math.IsNaN(p.Longitude) || math.IsInf(p.Longitude, 0) || math.Abs(p.Latitude) > 90 || math.Abs(p.Longitude) > 180 {
			return nil, errors.New("invalid coordinate")
		}
		rows[i] = strconv.FormatFloat(p.Latitude, 'f', -1, 64) + "," + strconv.FormatFloat(p.Longitude, 'f', -1, 64)
	}
	value := strings.Join(rows, ";")
	if len(value) > 2048 {
		return nil, errors.New("coordinate list exceeds candidate limit")
	}
	request := protowire.AppendTag(nil, 1, protowire.BytesType)
	request = protowire.AppendString(request, value)
	return action(90, request)
}

// EncodeSuperchargerCandidate requires an explicit experimental schema and a
// nonzero exact int64 station ID. No "nearest"/ID0 fallback. Identity provenance
// and user authorization MUST be established independently by a future caller.
// This function cannot prove Tesla accepts that station, order or firmware.
func EncodeSuperchargerCandidate(id, schema string) ([]byte, error) {
	if schema != SuperchargerSchema {
		return nil, errors.New("supercharger schema not explicitly selected")
	}
	if id == "" || id[0] == '0' || len(id) > 19 {
		return nil, errors.New("invalid Tesla station id")
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			return nil, errors.New("invalid Tesla station id")
		}
	}
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || n <= 0 {
		return nil, errors.New("invalid Tesla station id")
	}
	request := protowire.AppendTag(nil, 1, protowire.VarintType)
	request = protowire.AppendVarint(request, uint64(n))
	// Pinned third-party schema: order2 defaults to Replace0 and is omitted.
	// Conflicting legacy order1/2/3 sources are not interchangeable with this.
	return action(22, request)
}

func action(field protowire.Number, request []byte) ([]byte, error) {
	value := protowire.AppendTag(nil, field, protowire.BytesType)
	value = protowire.AppendBytes(value, request)
	vehicle := &carserver.VehicleAction{}
	vehicle.ProtoReflect().SetUnknown(value)
	return proto.Marshal(&carserver.Action{ActionMsg: &carserver.Action_VehicleAction{VehicleAction: vehicle}})
}
