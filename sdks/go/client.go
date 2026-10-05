// Package anyroute is the Go SDK for the Anyroute router, an OpenRouter-compatible AI router with signed receipts,
// privacy lanes and a Batch API.
//
// Start with NewClient; every call takes a context.Context. Responses carry the router's signed receipt, which
// VerifyReceiptV1 and VerifyReceiptV2 check offline.
package anyroute

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
)

// Version is the SDK version sent in the User-Agent header.
const Version = "0.1.0"

// DefaultBaseURL is the hosted router.
const DefaultBaseURL = "https://anyroute.tech"

// Lane is the privacy lane a request is served on.
type Lane string

const (
	LanePublic     Lane = "public"
	LaneAttested   Lane = "attested"
	LaneUnlinkable Lane = "unlinkable"
)

// Disclosure is the most a provider may disclose about a request (the X-Anyroute-Disclosure-Max ceiling).
type Disclosure string

const (
	DisclosureAny    Disclosure = "any"
	DisclosurePolicy Disclosure = "policy"
	DisclosureNone   Disclosure = "none"
)

var laneRank = map[string]int{"public": 0, "attested": 1, "unlinkable": 2}
var disclosureRank = map[string]int{"any": 0, "policy": 1, "none": 2}

// stricter returns the stricter of the value already present and the wanted one; a known present value that is
// stricter is kept, so an option never loosens a request.
func stricter(rank map[string]int, present any, want string) string {
	p, _ := present.(string)
	_, known := rank[p]
	if want == "" {
		if known {
			return p
		}
		return ""
	}
	if known && rank[p] > rank[want] {
		return p
	}
	return want
}

// Client talks to the Anyroute router. It is safe for concurrent use.
type Client struct {
	apiKey     string
	baseURL    string
	http       *http.Client
	lane       Lane
	disclosure Disclosure
	headers    http.Header

	mu   sync.Mutex
	keys *KeySet
}

// Option configures a Client.
type Option func(*Client)

// WithAPIKey sets the API key. The default is the ANYROUTE_API_KEY environment variable.
func WithAPIKey(key string) Option { return func(c *Client) { c.apiKey = key } }

// WithBaseURL sets the router URL. The default is ANYROUTE_BASE_URL, then DefaultBaseURL. A trailing /api/v1 is
// accepted and removed.
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = u } }

// WithHTTPClient sets the *http.Client used for every call.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithLane sets the default lane for every inference request.
func WithLane(l Lane) Option { return func(c *Client) { c.lane = l } }

// WithDisclosure sets the default disclosure ceiling for every inference request.
func WithDisclosure(d Disclosure) Option { return func(c *Client) { c.disclosure = d } }

// WithHeader adds a header to every request.
func WithHeader(key, value string) Option { return func(c *Client) { c.headers.Add(key, value) } }

// WithReceiptKeys pins the router's receipt keys, so VerifyReceipt never fetches them.
func WithReceiptKeys(ks *KeySet) Option { return func(c *Client) { c.keys = ks } }

// NewClient builds a Client.
func NewClient(opts ...Option) *Client {
	c := &Client{
		apiKey:  os.Getenv("ANYROUTE_API_KEY"),
		baseURL: os.Getenv("ANYROUTE_BASE_URL"),
		http:    http.DefaultClient,
		headers: http.Header{},
	}
	for _, o := range opts {
		o(c)
	}
	if c.baseURL == "" {
		c.baseURL = DefaultBaseURL
	}
	c.baseURL = strings.TrimRight(c.baseURL, "/")
	c.baseURL = strings.TrimSuffix(c.baseURL, "/api/v1")
	if c.http == nil {
		c.http = http.DefaultClient
	}
	return c
}

// BaseURL returns the router URL the client uses.
func (c *Client) BaseURL() string { return c.baseURL }

// RequestOption changes one call.
type RequestOption func(*requestConfig)

type requestConfig struct {
	lane       Lane
	disclosure Disclosure
	headers    http.Header
}

// WithRequestLane sets the lane for this call. It is sent as X-Anyroute-Lane and merged into provider.lane without
// loosening a stricter lane already in the body.
func WithRequestLane(l Lane) RequestOption { return func(r *requestConfig) { r.lane = l } }

// WithRequestDisclosure sets the disclosure ceiling for this call (X-Anyroute-Disclosure-Max and
// provider.disclosure, never loosening a stricter value already in the body).
func WithRequestDisclosure(d Disclosure) RequestOption {
	return func(r *requestConfig) { r.disclosure = d }
}

// WithRequestHeader adds a header to this call.
func WithRequestHeader(key, value string) RequestOption {
	return func(r *requestConfig) {
		if r.headers == nil {
			r.headers = http.Header{}
		}
		r.headers.Add(key, value)
	}
}

func (c *Client) config(opts []RequestOption) *requestConfig {
	rc := &requestConfig{lane: c.lane, disclosure: c.disclosure}
	for _, o := range opts {
		o(rc)
	}
	return rc
}

// toMap turns a request struct into a JSON object, keeping numbers exact.
func toMap(v any) (map[string]any, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(&buf)
	dec.UseNumber()
	m := map[string]any{}
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

// applyRouting merges lane and disclosure into body.provider and returns the headers to send. The header carries the
// value that ends up in the body, so both say the same thing.
func applyRouting(body map[string]any, lane Lane, disclosure Disclosure) http.Header {
	h := http.Header{}
	provider, _ := body["provider"].(map[string]any)
	if lane == "" && disclosure == "" {
		return h
	}
	if provider == nil {
		provider = map[string]any{}
	}
	if l := stricter(laneRank, provider["lane"], string(lane)); l != "" {
		provider["lane"] = l
		if lane != "" {
			h.Set("X-Anyroute-Lane", l)
		}
	}
	if d := stricter(disclosureRank, provider["disclosure"], string(disclosure)); d != "" {
		provider["disclosure"] = d
		if disclosure != "" {
			h.Set("X-Anyroute-Disclosure-Max", d)
		}
	}
	body["provider"] = provider
	return h
}

// buildBody encodes req, merges extra fields and routing, and returns the body and routing headers.
func buildBody(req any, extra map[string]any, rc *requestConfig) (map[string]any, http.Header, error) {
	body, err := toMap(req)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range extra {
		body[k] = v
	}
	if p, ok := body["provider"]; ok && p != nil {
		if _, isMap := p.(map[string]any); !isMap {
			if pm, err := toMap(p); err == nil {
				body["provider"] = pm
			}
		}
	}
	h := applyRouting(body, rc.lane, rc.disclosure)
	return body, h, nil
}

func (c *Client) newRequest(ctx context.Context, method, path string, body any, extra http.Header, rc *requestConfig) (*http.Request, error) {
	var rdr io.Reader
	if body != nil {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(body); err != nil {
			return nil, err
		}
		rdr = &buf
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil {
		return nil, err
	}
	for k, vs := range c.headers {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	req.Header.Set("User-Agent", "anyroute-go/"+Version)
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, vs := range extra {
		req.Header[k] = vs
	}
	if rc != nil {
		for k, vs := range rc.headers {
			req.Header[http.CanonicalHeaderKey(k)] = vs
		}
	}
	return req, nil
}

// send performs the request and turns a non-2xx answer into an *APIError.
func (c *Client) send(req *http.Request) (*http.Response, error) {
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		defer res.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		return nil, newAPIError(res, b)
	}
	return res, nil
}

// doJSON sends body (nil for none) and decodes a JSON answer into out. It returns the response headers.
func (c *Client) doJSON(ctx context.Context, method, path string, body any, out any, opts []RequestOption) (http.Header, error) {
	return c.doJSONWith(ctx, method, path, body, nil, out, c.config(opts))
}

func (c *Client) doJSONWith(ctx context.Context, method, path string, body any, extra http.Header, out any, rc *requestConfig) (http.Header, error) {
	req, err := c.newRequest(ctx, method, path, body, extra, rc)
	if err != nil {
		return nil, err
	}
	res, err := c.send(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if out != nil {
		if raw, ok := out.(*json.RawMessage); ok {
			*raw = b
		} else if err := json.Unmarshal(b, out); err != nil {
			return nil, wrapf("decoding %s %s: %v", method, path, err)
		}
	}
	return res.Header, nil
}

// Meta is what the router says about a call in its response headers.
type Meta struct {
	GenerationID string
	ReceiptID    string
	Lane         string
	// Disclosure is the class the request was served under: attested, policy or vendor-forwarded.
	Disclosure string
	PolicyHash string
	Header     http.Header
}

func metaFrom(h http.Header) Meta {
	return Meta{
		GenerationID: h.Get("X-Generation-Id"),
		ReceiptID:    h.Get("X-Receipt-Id"),
		Lane:         h.Get("X-Anyroute-Lane"),
		Disclosure:   h.Get("X-Anyroute-Disclosure"),
		PolicyHash:   h.Get("X-Anyroute-Policy-Hash"),
		Header:       h,
	}
}
