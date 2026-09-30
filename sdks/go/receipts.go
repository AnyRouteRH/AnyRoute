package anyroute

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ReceiptKeysPath is where the router publishes its receipt signing keys.
const ReceiptKeysPath = "/.well-known/anyroute-receipt-keys.json"

// Receipt is the signed receipt the router returns inline (the `receipt` field of a response or the last streamed
// event) and from GET /api/v1/receipts/{id}.
type Receipt struct {
	ID      string `json:"id,omitempty"`
	Version int    `json:"version,omitempty"`
	// Payload is kept as raw JSON so the signed bytes can be rebuilt exactly.
	Payload json.RawMessage `json:"payload"`
	// Sig is the base64 Ed25519 signature over the canonical JSON of Payload.
	Sig   string `json:"sig"`
	KeyID string `json:"key_id"`
	Alg   string `json:"alg,omitempty"`
	// Leaf is keccak256(keccak256(canonical payload || signature)), 0x-prefixed.
	Leaf       string          `json:"leaf,omitempty"`
	AnchorHint json.RawMessage `json:"anchor_hint,omitempty"`
	Anchor     *AnchorProof    `json:"anchor,omitempty"`
	V2         *ReceiptV2      `json:"v2,omitempty"`
	Privacy    json.RawMessage `json:"privacy,omitempty"`
}

// ReceiptV2 is the COSE_Sign1 form of a receipt.
type ReceiptV2 struct {
	Alg         string `json:"alg,omitempty"`
	Kid         string `json:"kid,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	// COSE is the base64 COSE_Sign1 message. It is what the signature covers.
	COSE   string         `json:"cose"`
	Claims *ReceiptClaims `json:"claims,omitempty"`
	Leaf   string         `json:"leaf,omitempty"`
	Anchor *AnchorProof   `json:"anchor,omitempty"`
}

// ReceiptClaims is the claim set inside a v2 receipt.
type ReceiptClaims struct {
	V     int    `json:"v"`
	RID   string `json:"rid"`
	IAT   int64  `json:"iat"`
	Iss   string `json:"iss,omitempty"`
	Model *struct {
		ID string `json:"id,omitempty"`
	} `json:"model,omitempty"`
	Node *struct {
		Provider   string `json:"provider,omitempty"`
		QuoteRef   string `json:"quote_ref,omitempty"`
		PolicyHash string `json:"policy_hash,omitempty"`
	} `json:"node,omitempty"`
	Req *struct {
		H         string `json:"h,omitempty"`
		NInBucket string `json:"n_in_bucket,omitempty"`
	} `json:"req,omitempty"`
	Resp *struct {
		H          string `json:"h,omitempty"`
		Chain      string `json:"chain,omitempty"`
		NOutBucket string `json:"n_out_bucket,omitempty"`
		Finish     string `json:"finish,omitempty"`
		Stream     bool   `json:"stream,omitempty"`
		Complete   bool   `json:"complete,omitempty"`
	} `json:"resp,omitempty"`
	Lane       string `json:"lane,omitempty"`
	Disclosure string `json:"disclosure,omitempty"`
	Policy     *struct {
		Enforced bool `json:"enforced"`
		Blocked  bool `json:"blocked"`
	} `json:"policy,omitempty"`
	Credit *struct {
		Mode      string `json:"mode,omitempty"`
		CostUnits int64  `json:"cost_units,omitempty"`
		Keyset    string `json:"keyset,omitempty"`
	} `json:"credit,omitempty"`
}

// AnchorProof is a Merkle inclusion proof for a receipt leaf.
type AnchorProof struct {
	Root     string   `json:"root,omitempty"`
	Proof    []string `json:"proof,omitempty"`
	Index    *int     `json:"index,omitempty"`
	Status   string   `json:"status,omitempty"`
	Anchored bool     `json:"anchored,omitempty"`
	Tx       *string  `json:"tx,omitempty"`
	Chain    int64    `json:"chain,omitempty"`
	Contract *string  `json:"contract,omitempty"`
}

// ReceiptProofResult is GET /api/v1/receipts/{id}/proof.
type ReceiptProofResult struct {
	RID         string          `json:"rid"`
	Leaf        string          `json:"leaf"`
	LeafVersion int             `json:"leaf_version"`
	Rooted      bool            `json:"rooted"`
	Anchored    bool            `json:"anchored"`
	Root        string          `json:"root,omitempty"`
	Proof       []string        `json:"proof,omitempty"`
	Status      string          `json:"status,omitempty"`
	Raw         json.RawMessage `json:"-"`
}

// ReceiptKey is one published receipt signing key (a JWK).
type ReceiptKey struct {
	Kty       string  `json:"kty"`
	Crv       string  `json:"crv"`
	X         string  `json:"x"`
	Kid       string  `json:"kid"`
	Use       string  `json:"use,omitempty"`
	Alg       string  `json:"alg,omitempty"`
	ValidFrom string  `json:"valid_from,omitempty"`
	RetiredAt *string `json:"retired_at,omitempty"`
}

// PublicKey decodes the raw Ed25519 key from X (base64url, padding optional).
func (k ReceiptKey) PublicKey() (ed25519.PublicKey, error) {
	raw, err := decodeBase64(k.X)
	if err != nil {
		return nil, err
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("receipt key %s is %d bytes, want 32", k.Kid, len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

// KeySet is the router's published key set.
type KeySet struct {
	Keys []ReceiptKey `json:"keys"`
}

// Find returns the key with this id.
func (s *KeySet) Find(kid string) (ReceiptKey, bool) {
	if s == nil {
		return ReceiptKey{}, false
	}
	for _, k := range s.Keys {
		if k.Kid == kid {
			return k, true
		}
	}
	return ReceiptKey{}, false
}

// CheckStatus is the outcome of one verification step. NotChecked is never a pass: it means the step did not run.
type CheckStatus string

const (
	CheckPass       CheckStatus = "pass"
	CheckFail       CheckStatus = "fail"
	CheckNotChecked CheckStatus = "not_checked"
)

// Check is one line of a verification report.
type Check struct {
	ID     string      `json:"id"`
	Status CheckStatus `json:"status"`
	Detail string      `json:"detail"`
}

// AnchorStatus says whether an inclusion proof was checked.
type AnchorStatus string

const (
	AnchorProofValid   AnchorStatus = "proof_valid"
	AnchorProofInvalid AnchorStatus = "proof_invalid"
	AnchorNoProof      AnchorStatus = "no_proof"
)

// ReceiptVerification is the result of VerifyReceiptV1.
type ReceiptVerification struct {
	// Valid is true only when the signature verifies under a key whose id is what it claims and no check failed.
	Valid  bool         `json:"valid"`
	KeyID  string       `json:"key_id"`
	Checks []Check      `json:"checks"`
	Anchor AnchorStatus `json:"anchor"`
}

// Check returns the check with this id.
func (v ReceiptVerification) Check(id string) (Check, bool) { return findCheck(v.Checks, id) }

func findCheck(cs []Check, id string) (Check, bool) {
	for _, c := range cs {
		if c.ID == id {
			return c, true
		}
	}
	return Check{}, false
}

type checkList []Check

func (l *checkList) pass(id, d string) { *l = append(*l, Check{id, CheckPass, d}) }
func (l *checkList) fail(id, d string) { *l = append(*l, Check{id, CheckFail, d}) }
func (l *checkList) skip(id, d string) { *l = append(*l, Check{id, CheckNotChecked, d}) }
func (l checkList) failed(id string) bool {
	for _, c := range l {
		if c.ID == id && c.Status == CheckFail {
			return true
		}
	}
	return false
}
func (l checkList) valid() bool {
	sig := false
	for _, c := range l {
		if c.Status == CheckFail {
			return false
		}
		if c.ID == "signature" && c.Status == CheckPass {
			sig = true
		}
	}
	return sig
}

// VerifyOptions says which key a receipt must verify under. Set one of Keys, PublicKey or PublicKeyHex.
type VerifyOptions struct {
	// Keys is the router's published key set (see Client.ReceiptKeys).
	Keys *KeySet
	// PublicKey is a raw Ed25519 key, used instead of Keys.
	PublicKey ed25519.PublicKey
	// PublicKeyHex is a raw Ed25519 key in hex, used instead of Keys.
	PublicKeyHex string
	// ClockSkew is the tolerance when comparing the receipt time with its key's validity window. Default 5 minutes.
	ClockSkew time.Duration
}

// KeyID is the id the router gives a key: the first 16 hex characters of sha256(raw public key).
func KeyID(pub []byte) string {
	h := sha256.Sum256(pub)
	return hex.EncodeToString(h[:])[:16]
}

// ReceiptLeafV1 is keccak256(keccak256(canonical || signature)), 0x-prefixed.
func ReceiptLeafV1(canonical, sig []byte) string {
	return "0x" + hex.EncodeToString(Keccak256(Keccak256(canonical, sig)))
}

// VerifyMerkleProof checks a sorted-pair keccak256 (OpenZeppelin style) inclusion proof.
func VerifyMerkleProof(leaf string, proof []string, root string) bool {
	h, err := hexBytes(leaf)
	if err != nil {
		return false
	}
	for _, p := range proof {
		q, err := hexBytes(p)
		if err != nil {
			return false
		}
		if bytes.Compare(h, q) < 0 {
			h = Keccak256(h, q)
		} else {
			h = Keccak256(q, h)
		}
	}
	r, err := hexBytes(root)
	return err == nil && bytes.Equal(h, r)
}

func hexBytes(s string) ([]byte, error) {
	return hex.DecodeString(strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X"))
}

func decodeBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if strings.ContainsAny(s, "-_") {
		return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	}
	if strings.HasSuffix(s, "=") || len(s)%4 == 0 {
		if b, err := base64.StdEncoding.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

// resolveKey picks the raw key a receipt must verify under and records the key check.
func resolveKey(checks *checkList, keyID string, opts VerifyOptions) (ed25519.PublicKey, *ReceiptKey) {
	var raw []byte
	switch {
	case len(opts.PublicKey) > 0 || opts.PublicKeyHex != "":
		raw = opts.PublicKey
		if len(raw) == 0 {
			b, err := hex.DecodeString(opts.PublicKeyHex)
			if err != nil {
				checks.fail("key", "The supplied public key is not hex.")
				return nil, nil
			}
			raw = b
		}
		if len(raw) != ed25519.PublicKeySize {
			checks.fail("key", "The supplied public key is not 32 bytes.")
			return nil, nil
		}
		if d := KeyID(raw); d != keyID {
			checks.fail("key", fmt.Sprintf("receipt key id %s is not the supplied key's id (%s)", keyID, d))
			return nil, nil
		}
		checks.pass("key", fmt.Sprintf("key id %s matches the supplied key", keyID))
		return raw, nil
	default:
		k, ok := opts.Keys.Find(keyID)
		if !ok {
			checks.fail("key", fmt.Sprintf("Key %s is not in the published key set.", keyID))
			return nil, nil
		}
		if k.Kty != "OKP" || k.Crv != "Ed25519" {
			checks.fail("key", "The published key is not an Ed25519 key.")
			return nil, nil
		}
		pub, err := k.PublicKey()
		if err != nil {
			checks.fail("key", "The published key is malformed.")
			return nil, nil
		}
		if d := KeyID(pub); d != keyID {
			checks.fail("key", fmt.Sprintf("the published key's id does not match its bytes (%s)", d))
			return nil, nil
		}
		checks.pass("key", fmt.Sprintf("key %s is in the published set and its id matches the key bytes", keyID))
		return pub, &k
	}
}

// VerifyReceiptV1 checks a v1 receipt: the key, the Ed25519 signature over the canonical JSON of the payload, the
// key's validity window, the leaf and (when present) the anchor proof. It never contacts the network.
func VerifyReceiptV1(r *Receipt, opts VerifyOptions) ReceiptVerification {
	var checks checkList
	out := func(anchor AnchorStatus) ReceiptVerification {
		keyID := ""
		if r != nil {
			keyID = r.KeyID
		}
		return ReceiptVerification{Valid: checks.valid(), KeyID: keyID, Checks: checks, Anchor: anchor}
	}
	if r == nil || len(r.Payload) == 0 || r.Payload[0] != '{' || r.Sig == "" || r.KeyID == "" {
		checks.fail("shape", "A receipt needs payload, sig and key_id.")
		return out(AnchorNoProof)
	}
	if r.Alg == "" || r.Alg == "Ed25519" {
		checks.pass("alg", "Ed25519")
	} else {
		checks.fail("alg", "unsupported algorithm "+r.Alg)
	}
	pub, jwk := resolveKey(&checks, r.KeyID, opts)

	sig, err := decodeBase64(r.Sig)
	if err != nil {
		sig = nil
		checks.fail("signature", "The signature is not valid base64.")
	}
	canonical, cerr := CanonicalJSON(r.Payload)
	if cerr != nil {
		checks.fail("shape", "The payload is not valid JSON: "+cerr.Error())
		return out(AnchorNoProof)
	}
	if pub != nil && sig != nil {
		if ed25519.Verify(pub, canonical, sig) {
			checks.pass("signature", "Ed25519 signature over the canonical payload verifies")
		} else {
			checks.fail("signature", "The signature does not verify for this payload and key.")
		}
	} else if _, ok := findCheck(checks, "signature"); !ok {
		checks.fail("signature", "Not verified: there is no usable key or signature.")
	}

	// Key validity window (router keys rotate and old keys stay published).
	skew := opts.ClockSkew
	if skew == 0 {
		skew = 5 * time.Minute
	}
	t, hasTime := payloadTime(r.Payload)
	var from, to *time.Time
	if jwk != nil {
		if tt, err := time.Parse(time.RFC3339Nano, jwk.ValidFrom); err == nil {
			from = &tt
		}
		if jwk.RetiredAt != nil {
			if tt, err := time.Parse(time.RFC3339Nano, *jwk.RetiredAt); err == nil {
				to = &tt
			}
		}
	}
	if hasTime && (from != nil || to != nil) {
		early := from != nil && t.Before(from.Add(-skew))
		late := to != nil && t.After(to.Add(skew))
		if early || late {
			checks.fail("key_window", "The receipt is dated outside its signing key's validity window.")
		} else {
			checks.pass("key_window", "The receipt time falls inside its key's validity window")
		}
	} else {
		checks.skip("key_window", "No key window or receipt time to compare.")
	}

	if r.Leaf != "" && sig != nil {
		if ReceiptLeafV1(canonical, sig) == strings.ToLower(r.Leaf) {
			checks.pass("leaf", "leaf = keccak256(keccak256(payload || signature)) matches")
		} else {
			checks.fail("leaf", "The leaf does not match the payload and signature.")
		}
	} else {
		checks.skip("leaf", "The receipt carries no leaf.")
	}

	anchor := AnchorNoProof
	if r.Anchor != nil && r.Anchor.Root != "" && r.Anchor.Proof != nil && r.Leaf != "" {
		if VerifyMerkleProof(r.Leaf, r.Anchor.Proof, r.Anchor.Root) {
			anchor = AnchorProofValid
			checks.pass("anchor_proof", "leaf is included under root "+r.Anchor.Root)
		} else {
			anchor = AnchorProofInvalid
			checks.fail("anchor_proof", "The inclusion proof does not lead from the leaf to the stated root.")
		}
	} else {
		checks.skip("anchor_proof", "No anchor proof supplied (a receipt is anchored within the hour; fetch it again later).")
	}
	return out(anchor)
}

func payloadTime(payload json.RawMessage) (time.Time, bool) {
	var p struct {
		TS     *float64 `json:"ts"`
		Issued string   `json:"issued"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return time.Time{}, false
	}
	if p.TS != nil {
		return time.UnixMilli(int64(*p.TS)), true
	}
	if p.Issued != "" {
		if t, err := time.Parse(time.RFC3339Nano, p.Issued); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// ---- client calls ------------------------------------------------------------------------------------------------

// GetReceipt fetches GET /api/v1/receipts/{id}, including its anchor proof once it has been anchored.
func (c *Client) GetReceipt(ctx context.Context, id string, opts ...RequestOption) (*Receipt, error) {
	var env struct {
		Data Receipt `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, "/api/v1/receipts/"+url.PathEscape(id), nil, &env, opts); err != nil {
		return nil, err
	}
	return &env.Data, nil
}

// ReceiptProof fetches GET /api/v1/receipts/{id}/proof.
func (c *Client) ReceiptProof(ctx context.Context, id string, opts ...RequestOption) (*ReceiptProofResult, error) {
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, "/api/v1/receipts/"+url.PathEscape(id)+"/proof", nil, &env, opts); err != nil {
		return nil, err
	}
	var p ReceiptProofResult
	if err := json.Unmarshal(env.Data, &p); err != nil {
		return nil, err
	}
	p.Raw = env.Data
	return &p, nil
}

// ReceiptKeys fetches the router's published receipt keys. The result is cached on the client; pass refresh to
// read them again (keys rotate).
func (c *Client) ReceiptKeys(ctx context.Context, refresh bool) (*KeySet, error) {
	c.mu.Lock()
	cached := c.keys
	c.mu.Unlock()
	if cached != nil && !refresh {
		return cached, nil
	}
	var ks KeySet
	if _, err := c.doJSON(ctx, http.MethodGet, ReceiptKeysPath, nil, &ks, nil); err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.keys = &ks
	c.mu.Unlock()
	return &ks, nil
}

// VerifyReceipt checks a receipt against the router's published keys, reading the key set again once when the
// receipt names a key it does not hold yet. A receipt with a v2 form is also checked as v2.
func (c *Client) VerifyReceipt(ctx context.Context, r *Receipt) (ReceiptVerification, error) {
	keys, err := c.ReceiptKeys(ctx, false)
	if err != nil {
		return ReceiptVerification{}, err
	}
	if r != nil {
		if _, ok := keys.Find(r.KeyID); !ok {
			if keys, err = c.ReceiptKeys(ctx, true); err != nil {
				return ReceiptVerification{}, err
			}
		}
	}
	v := VerifyReceiptV1(r, VerifyOptions{Keys: keys})
	if r != nil && r.V2 != nil && r.V2.COSE != "" {
		v2 := VerifyReceiptV2(r.V2.COSE, VerifyV2Options{Keys: keys})
		if v2.Valid {
			v.Checks = append(v.Checks, Check{"v2", CheckPass, "the COSE_Sign1 form verifies too"})
		} else {
			v.Checks = append(v.Checks, Check{"v2", CheckFail, "the COSE_Sign1 form does not verify"})
			v.Valid = false
		}
	}
	return v, nil
}
