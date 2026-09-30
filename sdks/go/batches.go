package anyroute

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// BatchRequestItem is one request inside a batch. URL is "/v1/chat/completions" or "/v1/embeddings"; Body is the
// request body without stream.
type BatchRequestItem struct {
	CustomID string `json:"custom_id"`
	Method   string `json:"method"`
	URL      string `json:"url"`
	Body     any    `json:"body"`
}

// CreateBatchRequest is the body of POST /api/v1/batches. Give Requests, or InputJSONL with the same lines as text.
type CreateBatchRequest struct {
	Requests         []BatchRequestItem `json:"requests,omitempty"`
	InputJSONL       string             `json:"input_jsonl,omitempty"`
	Endpoint         string             `json:"endpoint,omitempty"`
	CompletionWindow string             `json:"completion_window,omitempty"`
	Metadata         map[string]string  `json:"metadata,omitempty"`
}

// BatchRequestCounts counts a batch's requests.
type BatchRequestCounts struct {
	Total     int `json:"total"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
}

// BatchCost is what a batch cost, after the batch discount.
type BatchCost struct {
	USD         float64 `json:"usd"`
	ListUSD     float64 `json:"list_usd"`
	DiscountBps int     `json:"discount_bps"`
}

// Batch is the OpenAI-style batch object. Times are Unix seconds; nil when not reached.
type Batch struct {
	ID               string             `json:"id"`
	Object           string             `json:"object"`
	Endpoint         string             `json:"endpoint"`
	Status           string             `json:"status"`
	CompletionWindow string             `json:"completion_window,omitempty"`
	OutputURL        string             `json:"output_url,omitempty"`
	ErrorsURL        string             `json:"errors_url,omitempty"`
	CreatedAt        int64              `json:"created_at"`
	InProgressAt     *int64             `json:"in_progress_at"`
	ExpiresAt        *int64             `json:"expires_at"`
	FinalizingAt     *int64             `json:"finalizing_at"`
	CompletedAt      *int64             `json:"completed_at"`
	FailedAt         *int64             `json:"failed_at"`
	ExpiredAt        *int64             `json:"expired_at"`
	CancellingAt     *int64             `json:"cancelling_at"`
	CancelledAt      *int64             `json:"cancelled_at"`
	RequestCounts    BatchRequestCounts `json:"request_counts"`
	Cost             *BatchCost         `json:"cost,omitempty"`
	ResultsExpireAt  *int64             `json:"results_expire_at"`
	Metadata         map[string]string  `json:"metadata"`
}

// Batch statuses.
const (
	BatchValidating = "validating"
	BatchInProgress = "in_progress"
	BatchFinalizing = "finalizing"
	BatchCompleted  = "completed"
	BatchFailed     = "failed"
	BatchExpired    = "expired"
	BatchCancelling = "cancelling"
	BatchCancelled  = "cancelled"
)

// Terminal reports whether the batch will not change any more.
func (b *Batch) Terminal() bool {
	switch b.Status {
	case BatchCompleted, BatchFailed, BatchExpired, BatchCancelled:
		return true
	}
	return false
}

// BatchList is a page of batches.
type BatchList struct {
	Object  string  `json:"object"`
	Data    []Batch `json:"data"`
	FirstID string  `json:"first_id"`
	LastID  string  `json:"last_id"`
	HasMore bool    `json:"has_more"`
}

// ListBatchesParams pages through batches.
type ListBatchesParams struct {
	Limit int
	After string
}

// BatchResultLine is one line of a batch's output or errors JSONL.
type BatchResultLine struct {
	ID       string `json:"id"`
	CustomID string `json:"custom_id"`
	Response *struct {
		StatusCode int             `json:"status_code"`
		RequestID  string          `json:"request_id"`
		Body       json.RawMessage `json:"body"`
	} `json:"response"`
	Error *struct {
		Code    FlexString `json:"code"`
		Message string     `json:"message"`
	} `json:"error"`
}

// FlexString decodes a JSON string or number as a string.
type FlexString string

// UnmarshalJSON accepts a string, a number or null.
func (f *FlexString) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = FlexString(s)
		return nil
	}
	if string(b) == "null" {
		*f = ""
		return nil
	}
	*f = FlexString(b)
	return nil
}

// ChatResponse decodes the line's body as a chat completion.
func (l BatchResultLine) ChatResponse() (*ChatResponse, error) {
	if l.Response == nil {
		return nil, wrapf("batch line %s has no response", l.CustomID)
	}
	var r ChatResponse
	if err := json.Unmarshal(l.Response.Body, &r); err != nil {
		return nil, err
	}
	r.Raw = l.Response.Body
	return &r, nil
}

// CreateBatch submits a batch. A lane or disclosure set on the client or with a RequestOption is merged into every
// request body's provider object, never loosening a stricter value.
func (c *Client) CreateBatch(ctx context.Context, req CreateBatchRequest, opts ...RequestOption) (*Batch, error) {
	rc := c.config(opts)
	h := http.Header{}
	if rc.lane != "" {
		h.Set("X-Anyroute-Lane", string(rc.lane))
	}
	if rc.disclosure != "" {
		h.Set("X-Anyroute-Disclosure-Max", string(rc.disclosure))
	}
	if len(req.Requests) > 0 && (rc.lane != "" || rc.disclosure != "") {
		items := make([]BatchRequestItem, len(req.Requests))
		for i, it := range req.Requests {
			body, err := toMap(it.Body)
			if err != nil {
				return nil, wrapf("batch request %s: body must be a JSON object: %v", it.CustomID, err)
			}
			applyRouting(body, rc.lane, rc.disclosure)
			it.Body = body
			items[i] = it
		}
		req.Requests = items
	}
	var out Batch
	if _, err := c.doJSONWith(ctx, http.MethodPost, "/api/v1/batches", req, h, &out, rc); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetBatch reads one batch.
func (c *Client) GetBatch(ctx context.Context, id string, opts ...RequestOption) (*Batch, error) {
	var out Batch
	if _, err := c.doJSON(ctx, http.MethodGet, "/api/v1/batches/"+url.PathEscape(id), nil, &out, opts); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListBatches lists batches, newest first.
func (c *Client) ListBatches(ctx context.Context, p ListBatchesParams, opts ...RequestOption) (*BatchList, error) {
	v := url.Values{}
	if p.Limit > 0 {
		v.Set("limit", strconv.Itoa(p.Limit))
	}
	if p.After != "" {
		v.Set("after", p.After)
	}
	path := "/api/v1/batches"
	if len(v) > 0 {
		path += "?" + v.Encode()
	}
	var out BatchList
	if _, err := c.doJSON(ctx, http.MethodGet, path, nil, &out, opts); err != nil {
		return nil, err
	}
	return &out, nil
}

// CancelBatch asks the router to stop a batch.
func (c *Client) CancelBatch(ctx context.Context, id string, opts ...RequestOption) (*Batch, error) {
	var out Batch
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/batches/"+url.PathEscape(id)+"/cancel", nil, &out, opts); err != nil {
		return nil, err
	}
	return &out, nil
}

// BatchOutput returns the successful result lines of a batch.
func (c *Client) BatchOutput(ctx context.Context, id string, opts ...RequestOption) ([]BatchResultLine, error) {
	return c.batchLines(ctx, id, "output", opts)
}

// BatchErrors returns the failed, cancelled and expired result lines of a batch.
func (c *Client) BatchErrors(ctx context.Context, id string, opts ...RequestOption) ([]BatchResultLine, error) {
	return c.batchLines(ctx, id, "errors", opts)
}

func (c *Client) batchLines(ctx context.Context, id, which string, opts []RequestOption) ([]BatchResultLine, error) {
	var raw json.RawMessage
	rc := c.config(opts)
	h := http.Header{"Accept": {"application/x-ndjson, application/jsonl, */*"}}
	if _, err := c.doJSONWith(ctx, http.MethodGet, "/api/v1/batches/"+url.PathEscape(id)+"/"+which, nil, h, &raw, rc); err != nil {
		return nil, err
	}
	return ParseBatchJSONL(raw)
}

// ParseBatchJSONL parses batch output or errors JSONL, skipping blank lines.
func ParseBatchJSONL(b []byte) ([]BatchResultLine, error) {
	var out []BatchResultLine
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64*1024), 64<<20)
	n := 0
	for sc.Scan() {
		n++
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var l BatchResultLine
		if err := json.Unmarshal(line, &l); err != nil {
			return nil, wrapf("batch results line %d: %v", n, err)
		}
		out = append(out, l)
	}
	return out, sc.Err()
}

// WaitBatch polls a batch every pollInterval (default 5 seconds) until it reaches a terminal status or ctx ends.
// Use context.WithTimeout for a deadline.
func (c *Client) WaitBatch(ctx context.Context, id string, pollInterval time.Duration, opts ...RequestOption) (*Batch, error) {
	if pollInterval <= 0 {
		pollInterval = 5 * time.Second
	}
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		b, err := c.GetBatch(ctx, id, opts...)
		if err != nil {
			return nil, err
		}
		if b.Terminal() {
			return b, nil
		}
		select {
		case <-ctx.Done():
			return b, ctx.Err()
		case <-t.C:
		}
	}
}
