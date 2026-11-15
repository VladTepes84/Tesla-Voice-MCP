package handler

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestVercelRuntimeControlPlaneDoesNotUseTeslaBudget(t *testing.T) {
	t.Setenv("AWS_LAMBDA_RUNTIME_API", "127.0.0.1:9001")
	for _, tc := range []struct{ method, path string }{
		{"GET", "/2018-06-01/runtime/invocation/next"},
		{"POST", "/2018-06-01/runtime/invocation/request-id/response"},
		{"POST", "/2018-06-01/runtime/invocation/request-id/error"},
		{"POST", "/2018-06-01/runtime/init/error"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			calls := 0
			transport := fleetBudgetTransport{base: wakeTransport(func(*http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}, nil
			}), reserve: func(context.Context) error { t.Fatal("runtime request consumed Tesla budget"); return nil }}
			req, _ := http.NewRequest(tc.method, "http://127.0.0.1:9001"+tc.path, nil)
			response, err := transport.RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if calls != 1 {
				t.Fatal("runtime was not forwarded")
			}
		})
	}
}

func TestRuntimeExceptionDoesNotPermitArbitraryEgress(t *testing.T) {
	t.Setenv("AWS_LAMBDA_RUNTIME_API", "127.0.0.1:9001")
	for _, url := range []string{"http://127.0.0.1:9001/admin", "http://127.0.0.1:9002/2018-06-01/runtime/invocation/next", "http://example.invalid:9001/2018-06-01/runtime/invocation/next", "https://127.0.0.1:9001/2018-06-01/runtime/invocation/next", "http://127.0.0.1:9001/2018-06-01/runtime/invocation/next?url=external", "http://127.0.0.1:9001/2018-06-01/runtime/invocation/../admin"} {
		t.Run(url, func(t *testing.T) {
			transport := fleetBudgetTransport{base: wakeTransport(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected outbound request"); return nil, nil }), reserve: func(context.Context) error { t.Fatal("unexpected budget reservation"); return nil }}
			req, _ := http.NewRequest("GET", url, nil)
			if _, err := transport.RoundTrip(req); err == nil {
				t.Fatal("untrusted request allowed")
			}
		})
	}
	t.Setenv("AWS_LAMBDA_RUNTIME_API", "example.invalid:9001")
	req, _ := http.NewRequest("GET", "http://example.invalid:9001/2018-06-01/runtime/invocation/next", nil)
	transport := fleetBudgetTransport{base: wakeTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("non-loopback runtime authority allowed")
		return nil, nil
	})}
	if _, err := transport.RoundTrip(req); err == nil {
		t.Fatal("non-loopback runtime allowed")
	}
}
