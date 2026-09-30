package anyroute

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"net/http"
)

// EmbeddingsRequest is the body of POST /api/v1/embeddings. Input is a string or a list of strings.
type EmbeddingsRequest struct {
	Model          string               `json:"model"`
	Input          any                  `json:"input"`
	EncodingFormat string               `json:"encoding_format,omitempty"`
	Dimensions     *int                 `json:"dimensions,omitempty"`
	User           string               `json:"user,omitempty"`
	Provider       *ProviderPreferences `json:"provider,omitempty"`
	Extra          map[string]any       `json:"-"`
}

// Vector is an embedding. It decodes from a JSON array of numbers or from base64 little-endian float32 values.
type Vector []float64

// UnmarshalJSON accepts both encodings.
func (v *Vector) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		raw, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return err
		}
		if len(raw)%4 != 0 {
			return errors.New("anyroute: base64 embedding is not a whole number of float32 values")
		}
		out := make(Vector, len(raw)/4)
		for i := range out {
			out[i] = float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:])))
		}
		*v = out
		return nil
	}
	var f []float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	*v = f
	return nil
}

// Embedding is one input's vector.
type Embedding struct {
	Object    string `json:"object"`
	Index     int    `json:"index"`
	Embedding Vector `json:"embedding"`
}

// EmbeddingsResponse is the answer to Embeddings.
type EmbeddingsResponse struct {
	Object  string      `json:"object"`
	ID      string      `json:"id,omitempty"`
	Data    []Embedding `json:"data"`
	Model   string      `json:"model"`
	Usage   *Usage      `json:"usage,omitempty"`
	Receipt *Receipt    `json:"receipt,omitempty"`
	Meta    Meta        `json:"-"`
}

// Embeddings creates embeddings.
func (c *Client) Embeddings(ctx context.Context, req EmbeddingsRequest, opts ...RequestOption) (*EmbeddingsResponse, error) {
	rc := c.config(opts)
	body, h, err := buildBody(req, req.Extra, rc)
	if err != nil {
		return nil, err
	}
	var out EmbeddingsResponse
	hdr, err := c.doJSONWith(ctx, http.MethodPost, "/api/v1/embeddings", body, h, &out, rc)
	if err != nil {
		return nil, err
	}
	out.Meta = metaFrom(hdr)
	return &out, nil
}

// RerankDocument is a document given as an object.
type RerankDocument struct {
	Text string `json:"text"`
}

// UnmarshalJSON accepts a bare string or {"text": ...}.
func (d *RerankDocument) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		return json.Unmarshal(b, &d.Text)
	}
	var o struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		return err
	}
	d.Text = o.Text
	return nil
}

// RerankRequest is the body of POST /api/v1/rerank. Each entry of Documents is a string or a RerankDocument.
type RerankRequest struct {
	Model           string               `json:"model"`
	Query           string               `json:"query"`
	Documents       []any                `json:"documents"`
	TopN            *int                 `json:"top_n,omitempty"`
	ReturnDocuments *bool                `json:"return_documents,omitempty"`
	Provider        *ProviderPreferences `json:"provider,omitempty"`
	Extra           map[string]any       `json:"-"`
}

// RerankResult is one scored document.
type RerankResult struct {
	Index          int             `json:"index"`
	RelevanceScore float64         `json:"relevance_score"`
	Document       *RerankDocument `json:"document,omitempty"`
}

// RerankUsage is rerank accounting.
type RerankUsage struct {
	TotalTokens int     `json:"total_tokens"`
	SearchUnits int     `json:"search_units"`
	Cost        float64 `json:"cost"`
}

// RerankResponse is the answer to Rerank, results ordered by relevance.
type RerankResponse struct {
	ID      string         `json:"id"`
	Model   string         `json:"model"`
	Results []RerankResult `json:"results"`
	Usage   *RerankUsage   `json:"usage,omitempty"`
	Cost    float64        `json:"cost"`
	Receipt *Receipt       `json:"receipt,omitempty"`
	Meta    Meta           `json:"-"`
}

// Rerank scores documents against a query.
func (c *Client) Rerank(ctx context.Context, req RerankRequest, opts ...RequestOption) (*RerankResponse, error) {
	rc := c.config(opts)
	body, h, err := buildBody(req, req.Extra, rc)
	if err != nil {
		return nil, err
	}
	var out RerankResponse
	hdr, err := c.doJSONWith(ctx, http.MethodPost, "/api/v1/rerank", body, h, &out, rc)
	if err != nil {
		return nil, err
	}
	out.Meta = metaFrom(hdr)
	return &out, nil
}
