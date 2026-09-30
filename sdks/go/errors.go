package anyroute

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// APIError is a non-2xx answer from the router, parsed from its error envelope
// {"error": {"code", "message", "type", "metadata"}}.
type APIError struct {
	// StatusCode is the HTTP status.
	StatusCode int
	// Code is error.code from the body (normally the same as StatusCode).
	Code int
	// Type is the stable machine reason, for example rate_limited, model_not_found or invalid_request.
	Type     string
	Message  string
	Metadata map[string]any
	// RetryAfter is parsed from the Retry-After header (seconds or an HTTP date); 0 when absent.
	RetryAfter time.Duration
	// Header and Body are the raw response, for anything the fields above do not cover.
	Header http.Header
	Body   []byte
}

func (e *APIError) Error() string {
	var b strings.Builder
	b.WriteString("anyroute: ")
	b.WriteString(strconv.Itoa(e.StatusCode))
	if e.Type != "" {
		b.WriteString(" " + e.Type)
	}
	if e.Message != "" {
		b.WriteString(": " + e.Message)
	}
	return b.String()
}

// IsRateLimited reports whether err is an *APIError for a 429 or a rate_limited reason.
func IsRateLimited(err error) bool {
	var e *APIError
	return errors.As(err, &e) && (e.StatusCode == http.StatusTooManyRequests || e.Type == "rate_limited")
}

// RetryAfter returns how long the router asked the caller to wait, when err is an *APIError that carries it.
func RetryAfter(err error) (time.Duration, bool) {
	var e *APIError
	if errors.As(err, &e) && e.RetryAfter > 0 {
		return e.RetryAfter, true
	}
	return 0, false
}

func parseRetryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		if secs <= 0 {
			return 0
		}
		return time.Duration(secs * float64(time.Second))
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := t.Sub(now); d > 0 {
			return d
		}
	}
	return 0
}

func newAPIError(res *http.Response, body []byte) *APIError {
	e := &APIError{StatusCode: res.StatusCode, Header: res.Header, Body: body, RetryAfter: parseRetryAfter(res.Header.Get("Retry-After"), time.Now())}
	var env struct {
		Error *struct {
			Code     json.RawMessage `json:"code"`
			Message  string          `json:"message"`
			Type     string          `json:"type"`
			Metadata map[string]any  `json:"metadata"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &env) == nil && env.Error != nil {
		e.Message = env.Error.Message
		e.Type = env.Error.Type
		e.Metadata = env.Error.Metadata
		if n, err := strconv.Atoi(strings.Trim(string(env.Error.Code), `"`)); err == nil {
			e.Code = n
		} else if e.Type == "" && len(env.Error.Code) > 0 {
			e.Type = strings.Trim(string(env.Error.Code), `"`)
		}
	}
	if e.Code == 0 {
		e.Code = res.StatusCode
	}
	if e.Message == "" {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		e.Message = msg
	}
	return e
}

// ErrStreamRequired is returned by Chat when the request asks for a stream.
var ErrStreamRequired = errors.New("anyroute: use ChatStream for streaming requests")

func wrapf(format string, a ...any) error { return fmt.Errorf("anyroute: "+format, a...) }
