package anyroute

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// ProviderPreferences is the `provider` object of a request.
type ProviderPreferences struct {
	Lane           Lane       `json:"lane,omitempty"`
	Disclosure     Disclosure `json:"disclosure,omitempty"`
	Only           []string   `json:"only,omitempty"`
	Order          []string   `json:"order,omitempty"`
	Ignore         []string   `json:"ignore,omitempty"`
	AllowFallbacks *bool      `json:"allow_fallbacks,omitempty"`
	Sort           string     `json:"sort,omitempty"`
}

// Message is one chat message in a request. Content is a string or a list of content parts.
type Message struct {
	Role       string     `json:"role"`
	Content    any        `json:"content"`
	Name       string     `json:"name,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// SystemMessage, UserMessage and AssistantMessage build plain text messages.
func SystemMessage(text string) Message    { return Message{Role: "system", Content: text} }
func UserMessage(text string) Message      { return Message{Role: "user", Content: text} }
func AssistantMessage(text string) Message { return Message{Role: "assistant", Content: text} }

// ToolCall is a function call the model asked for.
type ToolCall struct {
	Index    *int   `json:"index,omitempty"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
	} `json:"function"`
}

// Tool is a function the model may call.
type Tool struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

// ToolFunction describes a callable function; Parameters is a JSON Schema.
type ToolFunction struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Parameters  any    `json:"parameters,omitempty"`
}

// ChatRequest is the body of POST /api/v1/chat/completions.
type ChatRequest struct {
	Model            string               `json:"model"`
	Messages         []Message            `json:"messages"`
	Models           []string             `json:"models,omitempty"`
	Temperature      *float64             `json:"temperature,omitempty"`
	TopP             *float64             `json:"top_p,omitempty"`
	MaxTokens        *int                 `json:"max_tokens,omitempty"`
	Stop             []string             `json:"stop,omitempty"`
	Seed             *int                 `json:"seed,omitempty"`
	FrequencyPenalty *float64             `json:"frequency_penalty,omitempty"`
	PresencePenalty  *float64             `json:"presence_penalty,omitempty"`
	Tools            []Tool               `json:"tools,omitempty"`
	ToolChoice       any                  `json:"tool_choice,omitempty"`
	ResponseFormat   any                  `json:"response_format,omitempty"`
	Stream           bool                 `json:"stream,omitempty"`
	User             string               `json:"user,omitempty"`
	Provider         *ProviderPreferences `json:"provider,omitempty"`
	// Extra fields are merged into the body as they are, for parameters this struct does not name.
	Extra map[string]any `json:"-"`
}

// Usage is token accounting.
type Usage struct {
	PromptTokens            int             `json:"prompt_tokens"`
	CompletionTokens        int             `json:"completion_tokens"`
	TotalTokens             int             `json:"total_tokens"`
	Cost                    *float64        `json:"cost,omitempty"`
	PromptTokensDetails     json.RawMessage `json:"prompt_tokens_details,omitempty"`
	CompletionTokensDetails json.RawMessage `json:"completion_tokens_details,omitempty"`
}

// ResponseMessage is the assistant message in a completion.
type ResponseMessage struct {
	Role      string     `json:"role"`
	Content   string     `json:"content"`
	Reasoning string     `json:"reasoning,omitempty"`
	Refusal   string     `json:"refusal,omitempty"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
}

// Choice is one completion choice.
type Choice struct {
	Index              int             `json:"index"`
	Message            ResponseMessage `json:"message"`
	FinishReason       string          `json:"finish_reason"`
	NativeFinishReason string          `json:"native_finish_reason,omitempty"`
	Logprobs           json.RawMessage `json:"logprobs,omitempty"`
}

// ChatResponse is a non-streamed chat completion.
type ChatResponse struct {
	ID                string   `json:"id"`
	Object            string   `json:"object"`
	Created           int64    `json:"created"`
	Model             string   `json:"model"`
	Provider          string   `json:"provider,omitempty"`
	Choices           []Choice `json:"choices"`
	Usage             *Usage   `json:"usage,omitempty"`
	SystemFingerprint string   `json:"system_fingerprint,omitempty"`
	Receipt           *Receipt `json:"receipt,omitempty"`
	// Meta is read from the response headers.
	Meta Meta `json:"-"`
	// Raw is the response body.
	Raw json.RawMessage `json:"-"`
}

// Text returns the content of the first choice.
func (r *ChatResponse) Text() string {
	if r == nil || len(r.Choices) == 0 {
		return ""
	}
	return r.Choices[0].Message.Content
}

// Chat sends a non-streamed chat completion.
func (c *Client) Chat(ctx context.Context, req ChatRequest, opts ...RequestOption) (*ChatResponse, error) {
	if req.Stream {
		return nil, ErrStreamRequired
	}
	rc := c.config(opts)
	body, h, err := buildBody(req, req.Extra, rc)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	hdr, err := c.doJSONWith(ctx, http.MethodPost, "/api/v1/chat/completions", body, h, &raw, rc)
	if err != nil {
		return nil, err
	}
	var out ChatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, wrapf("decoding chat completion: %v", err)
	}
	out.Raw = raw
	out.Meta = metaFrom(hdr)
	return &out, nil
}

// ChunkDelta is the incremental message in a streamed chunk.
type ChunkDelta struct {
	Role      string     `json:"role,omitempty"`
	Content   string     `json:"content,omitempty"`
	Reasoning string     `json:"reasoning,omitempty"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
}

// ChunkChoice is one choice in a streamed chunk.
type ChunkChoice struct {
	Index        int        `json:"index"`
	Delta        ChunkDelta `json:"delta"`
	FinishReason string     `json:"finish_reason,omitempty"`
}

// ChatChunk is one streamed event.
type ChatChunk struct {
	ID       string        `json:"id"`
	Object   string        `json:"object"`
	Created  int64         `json:"created"`
	Model    string        `json:"model"`
	Provider string        `json:"provider,omitempty"`
	Choices  []ChunkChoice `json:"choices"`
	Usage    *Usage        `json:"usage,omitempty"`
	Error    *struct {
		Code     json.RawMessage `json:"code"`
		Message  string          `json:"message"`
		Type     string          `json:"type"`
		Metadata map[string]any  `json:"metadata"`
	} `json:"error,omitempty"`
	// Raw is the exact data text of the event.
	Raw string `json:"-"`
}

// Stream reads a streamed chat completion. Call Next until it returns false, then check Err. After the stream ends,
// Receipt returns the signed receipt and VerifyChain checks the chunk hash chain.
type Stream struct {
	res     *http.Response
	r       *bufio.Reader
	chunk   *ChatChunk
	err     error
	done    bool
	receipt *Receipt
	events  []ChainedEvent
	// Meta is read from the response headers.
	Meta Meta
}

// ChatStream sends a chat completion with stream: true.
func (c *Client) ChatStream(ctx context.Context, req ChatRequest, opts ...RequestOption) (*Stream, error) {
	req.Stream = true
	rc := c.config(opts)
	body, h, err := buildBody(req, req.Extra, rc)
	if err != nil {
		return nil, err
	}
	h.Set("Accept", "text/event-stream")
	hr, err := c.newRequest(ctx, http.MethodPost, "/api/v1/chat/completions", body, h, rc)
	if err != nil {
		return nil, err
	}
	res, err := c.send(hr)
	if err != nil {
		return nil, err
	}
	return &Stream{res: res, r: bufio.NewReaderSize(res.Body, 64*1024), Meta: metaFrom(res.Header)}, nil
}

var chainComment = regexp.MustCompile(`^: anyroute-chain (\d+) ([0-9a-f]{64})$`)

// readBlock reads one SSE event block (lines up to a blank line). It returns io.EOF when nothing is left.
func (s *Stream) readBlock() ([]string, error) {
	var lines []string
	for {
		line, err := s.r.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if len(lines) > 0 {
					return lines, nil
				}
			} else {
				lines = append(lines, line)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(lines) > 0 {
				return lines, nil
			}
			return nil, err
		}
	}
}

// Next advances to the next chunk. It returns false at the end of the stream or on error.
func (s *Stream) Next() bool {
	if s.done || s.err != nil {
		return false
	}
	for {
		lines, err := s.readBlock()
		if err != nil {
			s.finish()
			if !errors.Is(err, io.EOF) {
				s.err = err
			}
			return false
		}
		var data []string
		for _, l := range lines {
			if strings.HasPrefix(l, ":") {
				if m := chainComment.FindStringSubmatch(l); m != nil {
					if i, _ := strconv.Atoi(m[1]); i == len(s.events) && i > 0 {
						s.events[i-1].Chain = m[2]
					}
				}
				continue
			}
			if strings.HasPrefix(l, "data:") {
				d := strings.TrimPrefix(l, "data:")
				d = strings.TrimPrefix(d, " ")
				data = append(data, d)
			}
		}
		if len(data) == 0 {
			continue
		}
		text := strings.Join(data, "\n")
		if text == "[DONE]" {
			s.drain()
			s.finish()
			return false
		}
		var probe struct {
			Receipt *Receipt `json:"receipt"`
		}
		if json.Unmarshal([]byte(text), &probe) == nil && probe.Receipt != nil && len(probe.Receipt.Payload) > 0 {
			s.receipt = probe.Receipt
			continue
		}
		s.events = append(s.events, ChainedEvent{Data: text})
		var ch ChatChunk
		if err := json.Unmarshal([]byte(text), &ch); err != nil {
			continue
		}
		ch.Raw = text
		if ch.Error != nil && len(ch.Choices) == 0 {
			e := &APIError{StatusCode: s.res.StatusCode, Type: ch.Error.Type, Message: ch.Error.Message, Metadata: ch.Error.Metadata, Header: s.res.Header, Body: []byte(text)}
			if n, err := strconv.Atoi(strings.Trim(string(ch.Error.Code), `"`)); err == nil {
				e.Code = n
			}
			s.err = e
			s.finish()
			return false
		}
		s.chunk = &ch
		return true
	}
}

// drain reads anything after [DONE] (a final chain comment, if any).
func (s *Stream) drain() {
	for {
		lines, err := s.readBlock()
		for _, l := range lines {
			if m := chainComment.FindStringSubmatch(l); m != nil {
				if i, _ := strconv.Atoi(m[1]); i == len(s.events) && i > 0 {
					s.events[i-1].Chain = m[2]
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *Stream) finish() {
	s.done = true
	s.chunk = nil
	if s.res != nil {
		s.res.Body.Close()
	}
}

// Chunk returns the chunk Next just read.
func (s *Stream) Chunk() *ChatChunk { return s.chunk }

// Err returns the error that ended the stream, if any.
func (s *Stream) Err() error { return s.err }

// Close releases the connection. It is safe to call more than once.
func (s *Stream) Close() error {
	if !s.done {
		s.finish()
	}
	return nil
}

// Receipt returns the signed receipt sent as the last event, once the stream has ended.
func (s *Stream) Receipt() *Receipt { return s.receipt }

// Events returns every event before the receipt, with the chain value the router sent after it.
func (s *Stream) Events() []ChainedEvent { return append([]ChainedEvent(nil), s.events...) }

// Chunks returns the data text of every event before the receipt, for VerifyV2Options.Chunks.
func (s *Stream) Chunks() []string {
	out := make([]string, len(s.events))
	for i, e := range s.events {
		out[i] = e.Data
	}
	return out
}

// VerifyChain recomputes the chunk hash chain over the events received and compares it with every chain value the
// router sent and with the head signed in the v2 receipt. A cut, reordered or altered stream fails. Call it after
// Next has returned false.
func (s *Stream) VerifyChain() ChainResult {
	rid := ""
	signed := ""
	if s.receipt != nil {
		rid = s.receipt.ID
		if s.receipt.V2 != nil && s.receipt.V2.Claims != nil {
			if s.receipt.V2.Claims.RID != "" {
				rid = s.receipt.V2.Claims.RID
			}
			if s.receipt.V2.Claims.Resp != nil {
				signed = s.receipt.V2.Claims.Resp.Chain
			}
		}
	}
	r := CheckChain(rid, s.events)
	r.SignedHead = signed
	r.OK = r.OK && signed != "" && signed == r.Head
	return r
}
