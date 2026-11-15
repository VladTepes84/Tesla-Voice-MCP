package redisfixture

// Shared TEST helper. Ephemeral Unix-socket Redis, no TCP, credentials or persistence.
import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func Start(t *testing.T) func(context.Context, ...string) (any, error) {
	t.Helper()
	binary := os.Getenv("TESLA_TEST_REDIS_SERVER")
	if binary == "" {
		t.Skip("set TESLA_TEST_REDIS_SERVER to run actual local Redis integration")
	}
	socket := filepath.Join(t.TempDir(), "redis.sock")
	cmd := exec.Command(binary, "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700", "--save", "", "--appendonly", "no", "--loglevel", "warning")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	command := Connect(socket)

	for i := 0; i < 100; i++ {
		if v, e := command(context.Background(), "PING"); e == nil && v == "PONG" {
			return command
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("local Redis failed to start")
	return nil
}

// Connect shares an already running local test Redis with the Node fixture.
func Connect(socket string) func(context.Context, ...string) (any, error) {
	return func(ctx context.Context, args ...string) (any, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
		if err != nil {
			return nil, err
		}
		defer c.Close()
		deadline := time.Now().Add(2 * time.Second)
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		_ = c.SetDeadline(deadline)
		var b strings.Builder
		fmt.Fprintf(&b, "*%d\r\n", len(args))
		for _, arg := range args {
			fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(arg), arg)
		}
		if _, err = io.WriteString(c, b.String()); err != nil {
			return nil, err
		}
		r := bufio.NewReader(c)
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if len(line) < 3 {
			return nil, fmt.Errorf("bad RESP")
		}
		value := strings.TrimSuffix(line[1:], "\r\n")
		switch line[0] {
		case '+':
			return value, nil
		case '-':
			return nil, fmt.Errorf("redis error")
		case ':':
			return strconv.ParseInt(value, 10, 64)
		case '$':
			n, e := strconv.Atoi(value)
			if e != nil {
				return nil, e
			}
			if n == -1 {
				return nil, nil
			}
			if n < 0 || n > 32768 {
				return nil, fmt.Errorf("bad bulk size")
			}
			data := make([]byte, n+2)
			_, e = io.ReadFull(r, data)
			return string(data[:n]), e
		default:
			return nil, fmt.Errorf("unsupported RESP")
		}
	}
}
