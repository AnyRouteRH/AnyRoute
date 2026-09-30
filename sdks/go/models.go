package anyroute

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

// Architecture describes a model's modalities.
type Architecture struct {
	Modality         string   `json:"modality"`
	InputModalities  []string `json:"input_modalities"`
	OutputModalities []string `json:"output_modalities"`
	Tokenizer        string   `json:"tokenizer"`
	InstructType     *string  `json:"instruct_type"`
}

// ModelAttestation is the strongest attestation an endpoint of the model offers now.
type ModelAttestation struct {
	Best          string          `json:"best"`
	ManifestRef   json.RawMessage `json:"manifest_ref"`
	ExecProfileID *string         `json:"exec_profile_id"`
	PolicyHash    *string         `json:"policy_hash"`
}

// ModelDisclosure counts endpoints per disclosure class (attested, policy, vendor-forwarded).
type ModelDisclosure struct {
	Best      *string        `json:"best"`
	Endpoints map[string]int `json:"endpoints"`
}

// Model is one entry of GET /api/v1/models.
type Model struct {
	ID                  string            `json:"id"`
	CanonicalSlug       string            `json:"canonical_slug,omitempty"`
	Name                string            `json:"name"`
	Created             int64             `json:"created"`
	Description         string            `json:"description"`
	ContextLength       int               `json:"context_length"`
	Architecture        Architecture      `json:"architecture"`
	Pricing             map[string]string `json:"pricing"`
	SupportedParameters []string          `json:"supported_parameters"`
	Lanes               []string          `json:"lanes"`
	AttestedAvailable   bool              `json:"attested_available"`
	Attestation         *ModelAttestation `json:"attestation"`
	Disclosure          *ModelDisclosure  `json:"disclosure"`
	RoutingVariants     []string          `json:"routing_variants"`
	// Raw is the full JSON object, for fields not named here.
	Raw json.RawMessage `json:"-"`
}

// SupportsLane reports whether the model can be served on lane now. Every model serves the public lane.
func (m Model) SupportsLane(l Lane) bool {
	if l == "" || (l == LanePublic && len(m.Lanes) == 0) {
		return true
	}
	for _, x := range m.Lanes {
		if x == string(l) {
			return true
		}
	}
	return false
}

// ModelsQuery filters the model list.
type ModelsQuery struct {
	// Lane keeps models that can be served on this lane.
	Lane Lane
	// OutputModalities keeps models that output any of these (for example "rerank" or "embeddings").
	OutputModalities []string
	// SupportedParameters keeps models that support all of these.
	SupportedParameters []string
}

// Models lists the models the router serves now. The filters are sent to the router and applied again here.
func (c *Client) Models(ctx context.Context, q ModelsQuery, opts ...RequestOption) ([]Model, error) {
	v := url.Values{}
	if q.Lane != "" {
		v.Set("lane", string(q.Lane))
	}
	if len(q.OutputModalities) > 0 {
		v.Set("output_modalities", strings.Join(q.OutputModalities, ","))
	}
	if len(q.SupportedParameters) > 0 {
		v.Set("supported_parameters", strings.Join(q.SupportedParameters, ","))
	}
	path := "/api/v1/models"
	if len(v) > 0 {
		path += "?" + v.Encode()
	}
	var env struct {
		Data []json.RawMessage `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, path, nil, &env, opts); err != nil {
		return nil, err
	}
	out := make([]Model, 0, len(env.Data))
	for _, raw := range env.Data {
		var m Model
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, wrapf("decoding model: %v", err)
		}
		m.Raw = raw
		if !m.SupportsLane(q.Lane) || !hasAny(m.Architecture.OutputModalities, q.OutputModalities) || !hasAll(m.SupportedParameters, q.SupportedParameters) {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

func hasAny(have, want []string) bool {
	if len(want) == 0 {
		return true
	}
	for _, w := range want {
		for _, h := range have {
			if h == w {
				return true
			}
		}
	}
	return false
}

func hasAll(have, want []string) bool {
	for _, w := range want {
		if !hasAny(have, []string{w}) {
			return false
		}
	}
	return true
}
