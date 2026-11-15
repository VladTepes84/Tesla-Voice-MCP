package gpscandidate

import (
	"bytes"
	"encoding/hex"
	"math"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
)

// Independent external golden fixture, synthetic coordinates, no vehicle trace:
// Teslemetry/tesla-protocol 2c45a2f9 fixtures/golden/navigation_gps_request.json.
func TestExternalGoldenCoordinatePayload(t *testing.T) {
	cases := []struct {
		p   Point
		hex string
	}{
		{Point{37.5, -122.25}, "1215aa0312090000000000c04240110000000000905ec0"},
		{Point{0, 0}, "1203aa0300"},
		{Point{-33.875, 151.25}, "1215aa0312090000000000f040c0110000000000e86240"},
		{Point{90, 180}, "1215aa0312090000000000805640110000000000806640"},
	}
	for _, c := range cases {
		payloads, err := EncodeRoute([]Point{c.p, c.p})
		if err != nil || hex.EncodeToString(payloads[0]) != c.hex {
			t.Fatalf("external golden mismatch: %x %v", payloads, err)
		}
	}
}

func TestAppendOrderAndReturnPointPreserved(t *testing.T) {
	points := []Point{{45.5, 9.1}, {45.6, 9.2}, {45.5, 9.1}}
	payloads, err := EncodeRoute(points)
	if err != nil || len(payloads) != 3 {
		t.Fatal(err)
	}
	for i, payload := range payloads {
		tag, typ, n := protowire.ConsumeTag(payload)
		if tag != 2 || typ != protowire.BytesType || n < 0 {
			t.Fatal("wrong outer action")
		}
		action, used := protowire.ConsumeBytes(payload[n:])
		if used < 0 || n+used != len(payload) {
			t.Fatal("bad wrapper")
		}
		tag, typ, n = protowire.ConsumeTag(action)
		if tag != 53 || typ != protowire.BytesType || n < 0 {
			t.Fatal("wrong GPS action")
		}
		request, used := protowire.ConsumeBytes(action[n:])
		if used < 0 || n+used != len(action) {
			t.Fatal("bad GPS wrapper")
		}
		var lat, lon float64
		var order uint64
		fields := 0
		for len(request) > 0 {
			tag, typ, n = protowire.ConsumeTag(request)
			if n < 0 {
				t.Fatal("bad field")
			}
			request = request[n:]
			switch tag {
			case 1, 2:
				if typ != protowire.Fixed64Type {
					t.Fatal("coordinate wire type")
				}
				bits, count := protowire.ConsumeFixed64(request)
				if count < 0 {
					t.Fatal("bad coordinate")
				}
				request = request[count:]
				if tag == 1 {
					lat = math.Float64frombits(bits)
				} else {
					lon = math.Float64frombits(bits)
				}
			case 3:
				if typ != protowire.VarintType {
					t.Fatal("order wire type")
				}
				var count int
				order, count = protowire.ConsumeVarint(request)
				if count < 0 {
					t.Fatal("bad order")
				}
				request = request[count:]
			default:
				t.Fatal("unexpected field")
			}
			fields++
		}
		expected := uint64(2)
		expectedFields := 3
		if i == 0 {
			expected = 0
			expectedFields = 2
		}
		if lat != points[i].Latitude || lon != points[i].Longitude || order != expected || fields != expectedFields {
			t.Fatalf("point %d changed: %v %v %v", i, lat, lon, order)
		}
	}
}

func TestDiagnosticPointCodecMatchesExistingReplaceAndAppendPayloads(t *testing.T) {
	points := []Point{{Latitude: 45.5499106, Longitude: 9.0782851}, {Latitude: 45.4641669, Longitude: 9.1916121}}
	full, err := EncodeRoute(points)
	if err != nil {
		t.Fatal(err)
	}
	replace, err := EncodeDiagnosticPoint(points[0], false)
	if err != nil {
		t.Fatal(err)
	}
	appendStep, err := EncodeDiagnosticPoint(points[1], true)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(replace, full[0]) || !bytes.Equal(appendStep, full[1]) {
		t.Fatal("diagnostic payloads diverged from the existing route codec")
	}
	if bytes.Equal(replace, appendStep) {
		t.Fatal("Replace and Append payloads must differ in the order field")
	}
}

func TestInvalidRouteReturnsNoPartialPayload(t *testing.T) {
	for _, bad := range []Point{{91, 0}, {0, 181}, {-91, 0}, {0, -181}, {math.NaN(), 0}, {0, math.Inf(1)}} {
		payloads, err := EncodeRoute([]Point{{45, 9}, bad})
		if err == nil || payloads != nil {
			t.Fatal("invalid route produced payloads")
		}
	}
	for _, count := range []int{0, 1, 17} {
		payloads, err := EncodeRoute(make([]Point, count))
		if err == nil || payloads != nil {
			t.Fatal("invalid route size accepted")
		}
	}
}
