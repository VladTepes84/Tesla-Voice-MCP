package navigationcontracts

import (
	"math"
	"strconv"
	"strings"
	"testing"

	carserver "github.com/teslamotors/vehicle-command/pkg/protocol/protobuf/carserver"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

func inner(t *testing.T, b []byte, field protowire.Number) []byte {
	t.Helper()
	var official carserver.Action
	if err := proto.Unmarshal(b, &official); err != nil || official.GetVehicleAction() == nil {
		t.Fatal("not an SDK Action")
	}
	n, typ, k := protowire.ConsumeTag(b)
	if n != 2 || typ != protowire.BytesType {
		t.Fatal("not VehicleAction")
	}
	v, z := protowire.ConsumeBytes(b[k:])
	if z != len(b)-k {
		t.Fatal("more than one Action")
	}
	n, typ, k = protowire.ConsumeTag(v)
	if n != field || typ != protowire.BytesType {
		t.Fatal("wrong candidate arm")
	}
	request, z := protowire.ConsumeBytes(v[k:])
	if z != len(v)-k {
		t.Fatal("multiple vehicle operations")
	}
	return request
}

func TestCoordinateBatchContainsAllStopsOnceInOneAction(t *testing.T) {
	points := []Point{{45.1, 9.1}, {45.2, 9.2}, {45.3, 9.3}, {45.1, 9.1}}
	payload, err := EncodeCoordinateBatchCandidate(points, CoordinateBatchSchema)
	if err != nil {
		t.Fatal(err)
	}
	request := inner(t, payload, 90)
	n, typ, k := protowire.ConsumeTag(request)
	if n != 1 || typ != protowire.BytesType {
		t.Fatal("wrong list field")
	}
	text, z := protowire.ConsumeString(request[k:])
	if z != len(request)-k {
		t.Fatal("invented options")
	}
	if text != "45.1,9.1;45.2,9.2;45.3,9.3;45.1,9.1" {
		t.Fatal("lost DC stop/order/return")
	}
	if strings.Contains(text, "refId") {
		t.Fatal("Google identifier substituted")
	}
}

func TestCoordinateBatchPreservesDecimalCoordinatesWithoutRounding(t *testing.T) {
	points := []Point{{0.0000001, -0.0000001}, {45.123456789123, 9.987654321987}}
	payload, err := EncodeCoordinateBatchCandidate(points, CoordinateBatchSchema)
	if err != nil {
		t.Fatal(err)
	}
	request := inner(t, payload, 90)
	_, _, k := protowire.ConsumeTag(request)
	text, _ := protowire.ConsumeString(request[k:])
	for i, row := range strings.Split(text, ";") {
		fields := strings.Split(row, ",")
		lat, _ := strconv.ParseFloat(fields[0], 64)
		lon, _ := strconv.ParseFloat(fields[1], 64)
		if lat != points[i].Latitude || lon != points[i].Longitude {
			t.Fatal("rounded")
		}
	}
}

func TestCoordinateCandidateRejectsMissingApprovalAndInvalidWholeList(t *testing.T) {
	good := []Point{{45, 9}, {46, 10}}
	if b, err := EncodeCoordinateBatchCandidate(good, ""); err == nil || b != nil {
		t.Fatal("implicit schema")
	}
	for _, points := range [][]Point{nil, {{45, 9}}, make([]Point, 17), {{45, 9}, {91, 9}}, {{45, 9}, {46, math.NaN()}}, {{math.Inf(1), 9}, {46, 10}}} {
		if b, err := EncodeCoordinateBatchCandidate(points, CoordinateBatchSchema); err == nil || b != nil {
			t.Fatal("partial/invalid route encoded")
		}
	}
	if _, err := EncodeCoordinateBatchCandidate(make([]Point, 16), CoordinateBatchSchema); err != nil {
		t.Fatal(err)
	}
}

func TestSuperchargerPreservesExactChosenInt64IDInOneAction(t *testing.T) {
	payload, err := EncodeSuperchargerCandidate("9223372036854775807", SuperchargerSchema)
	if err != nil {
		t.Fatal(err)
	}
	request := inner(t, payload, 22)
	n, typ, k := protowire.ConsumeTag(request)
	if n != 1 || typ != protowire.VarintType {
		t.Fatal("station id missing")
	}
	id, z := protowire.ConsumeVarint(request[k:])
	if id != math.MaxInt64 || z != len(request)-k {
		t.Fatal("id changed/order guessed")
	}
}

func TestSuperchargerNeverSubstitutesNearestAddressOrEVSE(t *testing.T) {
	for _, id := range []string{"", "0", "01", "-1", "+1", "1.5", "1e3", "9223372036854775808", "IT*ABC*E123", "refId:PLACE", "45.5,9.1", "Westville"} {
		if b, err := EncodeSuperchargerCandidate(id, SuperchargerSchema); err == nil || b != nil {
			t.Fatal("invalid/implicit target accepted")
		}
	}
	if b, err := EncodeSuperchargerCandidate("123", ""); err == nil || b != nil {
		t.Fatal("implicit schema")
	}
}
