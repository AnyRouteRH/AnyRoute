package anyroute

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"
)

// Receipt v2 is a COSE_Sign1 message (RFC 9052, CBOR tag 18) over a deterministic CBOR claim set, signed EdDSA (-8)
// with the router's Ed25519 receipt key. The protected header's kid is the 8 raw bytes of the key id. The checks run
// in this order: signature, streamed chain head, anchor proof.

// COSEAlgEdDSA is the COSE algorithm id for EdDSA.
const COSEAlgEdDSA = -8

// ---- minimal CBOR decoder (definite lengths only, the subset receipts use) ---------------------------------------

type cborTag struct {
	Tag   uint64
	Value any
}

type cborDecoder struct {
	b  []byte
	at int
}

const maxCBORDepth = 64

func decodeCBOR(b []byte) (any, error) {
	d := &cborDecoder{b: b}
	v, err := d.item(0)
	if err != nil {
		return nil, err
	}
	if d.at != len(b) {
		return nil, errors.New("cbor: trailing bytes")
	}
	return v, nil
}

func (d *cborDecoder) need(n uint64) error {
	if n > uint64(len(d.b)-d.at) {
		return errors.New("cbor: truncated")
	}
	return nil
}

func (d *cborDecoder) item(depth int) (any, error) {
	if depth > maxCBORDepth {
		return nil, errors.New("cbor: nesting too deep")
	}
	if err := d.need(1); err != nil {
		return nil, err
	}
	ib := d.b[d.at]
	d.at++
	major, info := ib>>5, ib&0x1f
	if major == 7 {
		switch info {
		case 20:
			return false, nil
		case 21:
			return true, nil
		case 22, 23:
			return nil, nil
		}
		return nil, errors.New("cbor: unsupported simple value or float")
	}
	n := uint64(info)
	if info >= 24 {
		size := map[byte]uint64{24: 1, 25: 2, 26: 4, 27: 8}[info]
		if size == 0 {
			return nil, errors.New("cbor: indefinite lengths are not allowed")
		}
		if err := d.need(size); err != nil {
			return nil, err
		}
		n = 0
		for i := uint64(0); i < size; i++ {
			n = n<<8 | uint64(d.b[d.at])
			d.at++
		}
	}
	switch major {
	case 0:
		if n > math.MaxInt64 {
			return n, nil
		}
		return int64(n), nil
	case 1:
		if n > math.MaxInt64 {
			return nil, errors.New("cbor: negative integer out of range")
		}
		return -1 - int64(n), nil
	case 2, 3:
		if err := d.need(n); err != nil {
			return nil, err
		}
		s := d.b[d.at : d.at+int(n)]
		d.at += int(n)
		if major == 2 {
			return append([]byte(nil), s...), nil
		}
		if !utf8.Valid(s) {
			return nil, errors.New("cbor: invalid utf-8 in text string")
		}
		return string(s), nil
	case 4:
		if n > uint64(len(d.b)) {
			return nil, errors.New("cbor: truncated")
		}
		arr := make([]any, 0, n)
		for i := uint64(0); i < n; i++ {
			v, err := d.item(depth + 1)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		return arr, nil
	case 5:
		if n > uint64(len(d.b)) {
			return nil, errors.New("cbor: truncated")
		}
		m := make(map[any]any, n)
		for i := uint64(0); i < n; i++ {
			k, err := d.item(depth + 1)
			if err != nil {
				return nil, err
			}
			switch k.(type) {
			case int64, uint64, string, bool, nil:
			default:
				return nil, errors.New("cbor: unsupported map key type")
			}
			v, err := d.item(depth + 1)
			if err != nil {
				return nil, err
			}
			m[k] = v
		}
		return m, nil
	default: // 6: tag
		v, err := d.item(depth + 1)
		if err != nil {
			return nil, err
		}
		return cborTag{Tag: n, Value: v}, nil
	}
}

func cborHead(major byte, n uint64) []byte {
	switch {
	case n < 24:
		return []byte{major<<5 | byte(n)}
	case n < 1<<8:
		return []byte{major<<5 | 24, byte(n)}
	case n < 1<<16:
		b := []byte{major<<5 | 25, 0, 0}
		binary.BigEndian.PutUint16(b[1:], uint16(n))
		return b
	case n < 1<<32:
		b := []byte{major<<5 | 26, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(b[1:], uint32(n))
		return b
	default:
		b := []byte{major<<5 | 27, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint64(b[1:], n)
		return b
	}
}

// SigStructure builds the COSE_Sign1 Sig_structure ["Signature1", protected, h” (external aad), payload], the exact
// bytes the Ed25519 signature covers.
func SigStructure(protected, payload []byte) []byte {
	var b bytes.Buffer
	b.Write(cborHead(4, 4))
	b.Write(cborHead(3, uint64(len("Signature1"))))
	b.WriteString("Signature1")
	b.Write(cborHead(2, uint64(len(protected))))
	b.Write(protected)
	b.Write(cborHead(2, 0))
	b.Write(cborHead(2, uint64(len(payload))))
	b.Write(payload)
	return b.Bytes()
}

// cborToJSON turns decoded CBOR into values encoding/json can write (byte strings become hex).
func cborToJSON(v any) any {
	switch t := v.(type) {
	case map[any]any:
		o := make(map[string]any, len(t))
		for k, x := range t {
			o[fmt.Sprint(k)] = cborToJSON(x)
		}
		return o
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = cborToJSON(x)
		}
		return out
	case []byte:
		return hex.EncodeToString(t)
	case uint64:
		return strconv.FormatUint(t, 10)
	case cborTag:
		return map[string]any{"tag": t.Tag, "value": cborToJSON(t.Value)}
	}
	return v
}

// DecodedReceiptV2 is a parsed COSE_Sign1 receipt.
type DecodedReceiptV2 struct {
	Alg       int64
	KeyID     string
	Claims    ReceiptClaims
	ClaimsMap map[string]any
	Protected []byte
	Payload   []byte
	Signature []byte
	// COSE is the full message bytes.
	COSE []byte
}

func coseBytes[T []byte | string](cose T) ([]byte, error) {
	switch v := any(cose).(type) {
	case []byte:
		return v, nil
	case string:
		return decodeBase64(v)
	}
	return nil, errors.New("unreachable")
}

// DecodeReceiptV2 parses COSE_Sign1 bytes, or their base64 text, into header, claims and signature.
func DecodeReceiptV2[T []byte | string](cose T) (*DecodedReceiptV2, error) {
	b, err := coseBytes(cose)
	if err != nil {
		return nil, fmt.Errorf("receipt v2: bad base64: %w", err)
	}
	return decodeReceiptV2Bytes(b)
}

func decodeReceiptV2Bytes(b []byte) (*DecodedReceiptV2, error) {
	v, err := decodeCBOR(b)
	if err != nil {
		return nil, err
	}
	if t, ok := v.(cborTag); ok {
		if t.Tag != 18 {
			return nil, fmt.Errorf("not a COSE_Sign1 (tag %d)", t.Tag)
		}
		v = t.Value
	}
	arr, ok := v.([]any)
	if !ok || len(arr) != 4 {
		return nil, errors.New("COSE_Sign1 must be an array of four items")
	}
	prot, ok1 := arr[0].([]byte)
	payload, ok2 := arr[2].([]byte)
	sig, ok3 := arr[3].([]byte)
	if !ok1 || !ok2 || !ok3 {
		return nil, errors.New("COSE_Sign1 items have the wrong types")
	}
	hv, err := decodeCBOR(prot)
	if err != nil {
		return nil, fmt.Errorf("protected header: %w", err)
	}
	hdr, ok := hv.(map[any]any)
	if !ok {
		return nil, errors.New("protected header is not a map")
	}
	out := &DecodedReceiptV2{Protected: prot, Payload: payload, Signature: sig, COSE: b}
	if alg, ok := hdr[int64(1)].(int64); ok {
		out.Alg = alg
	}
	if kid, ok := hdr[int64(4)].([]byte); ok {
		out.KeyID = hex.EncodeToString(kid)
	}
	cv, err := decodeCBOR(payload)
	if err != nil {
		return nil, fmt.Errorf("claims: %w", err)
	}
	cm, ok := cborToJSON(cv).(map[string]any)
	if !ok {
		return nil, errors.New("claims are not a map")
	}
	out.ClaimsMap = cm
	j, _ := json.Marshal(cm)
	if err := json.Unmarshal(j, &out.Claims); err != nil {
		return nil, fmt.Errorf("claims: %w", err)
	}
	return out, nil
}

// ReceiptLeafV2 is the v2 anchor leaf: keccak256(keccak256(COSE bytes)), 0x-prefixed.
func ReceiptLeafV2(cose []byte) string {
	return "0x" + hex.EncodeToString(Keccak256(Keccak256(cose)))
}

// ---- chunk hash chain ---------------------------------------------------------------------------------------------

// ChunkChain computes c0 = SHA-256(rid), c_i = SHA-256(c_{i-1} || chunk_i). It returns every c_i in hex and the head
// ("sha256:<hex>").
func ChunkChain(rid string, chunks []string) (steps []string, head string) {
	h := sha256.Sum256([]byte(rid))
	c := h[:]
	for _, d := range chunks {
		s := sha256.New()
		s.Write(c)
		s.Write([]byte(d))
		c = s.Sum(nil)
		steps = append(steps, hex.EncodeToString(c))
	}
	return steps, "sha256:" + hex.EncodeToString(c)
}

// ChainedEvent is one streamed event as the client saw it: its data text and the chain value the router sent after
// it ("" when none arrived).
type ChainedEvent struct {
	Data  string `json:"data"`
	Chain string `json:"chain,omitempty"`
}

// ChainResult is the outcome of CheckChain or Stream.VerifyChain.
type ChainResult struct {
	OK   bool
	Head string
	// SignedHead is the head the receipt signs (resp.chain), when known.
	SignedHead string
	// FirstMismatch is the 1-based index of the first event whose chain value is missing or wrong; 0 when none.
	FirstMismatch int
}

// CheckChain recomputes the chain over the events and compares each step with the value the router sent.
func CheckChain(rid string, events []ChainedEvent) ChainResult {
	data := make([]string, len(events))
	for i, e := range events {
		data[i] = e.Data
	}
	steps, head := ChunkChain(rid, data)
	res := ChainResult{OK: true, Head: head}
	for i, e := range events {
		if e.Chain != steps[i] {
			res.OK = false
			res.FirstMismatch = i + 1
			break
		}
	}
	return res
}

// ---- verification ---------------------------------------------------------------------------------------------------

// VerifyV2Options says which key a v2 receipt must verify under and what else to check.
type VerifyV2Options struct {
	Keys         *KeySet
	PublicKey    ed25519.PublicKey
	PublicKeyHex string
	// Chunks is the data of every streamed event before the receipt, in order: recomputes the chain head.
	Chunks []string
	// Proof is from GET /api/v1/receipts/{id}/proof.
	Proof *ReceiptProofResult
}

// ReceiptV2Verification is the result of VerifyReceiptV2.
type ReceiptV2Verification struct {
	Valid  bool           `json:"valid"`
	KeyID  string         `json:"key_id"`
	Claims *ReceiptClaims `json:"claims"`
	Leaf   string         `json:"leaf"`
	Checks []Check        `json:"checks"`
	Anchor AnchorStatus   `json:"anchor"`
}

// Check returns the check with this id.
func (v ReceiptV2Verification) Check(id string) (Check, bool) { return findCheck(v.Checks, id) }

// VerifyReceiptV2 checks a COSE_Sign1 receipt given as raw bytes or base64 text.
func VerifyReceiptV2[T []byte | string](cose T, opts VerifyV2Options) ReceiptV2Verification {
	var checks checkList
	b, err := coseBytes(cose)
	var d *DecodedReceiptV2
	if err == nil {
		d, err = decodeReceiptV2Bytes(b)
	}
	if err != nil {
		checks.fail("shape", "Not a COSE_Sign1 receipt: "+err.Error())
		return ReceiptV2Verification{Checks: checks, Anchor: AnchorNoProof}
	}
	if d.Alg == COSEAlgEdDSA {
		checks.pass("alg", "EdDSA (COSE -8)")
	} else {
		checks.fail("alg", fmt.Sprintf("unsupported COSE algorithm %d", d.Alg))
	}
	if d.Claims.V == 2 && d.Claims.RID != "" {
		checks.pass("claims", "v2 claims for "+d.Claims.RID)
	} else {
		checks.fail("claims", "The payload is not a v2 claim set.")
	}

	pub, _ := resolveKey(&checks, d.KeyID, VerifyOptions{Keys: opts.Keys, PublicKey: opts.PublicKey, PublicKeyHex: opts.PublicKeyHex})
	if pub != nil && !checks.failed("key") {
		if ed25519.Verify(pub, SigStructure(d.Protected, d.Payload), d.Signature) {
			checks.pass("signature", "COSE_Sign1 signature verifies")
		} else {
			checks.fail("signature", "The COSE signature does not verify for these claims and key.")
		}
	} else {
		checks.fail("signature", "Not verified: no usable key.")
	}

	chain := ""
	if d.Claims.Resp != nil {
		chain = d.Claims.Resp.Chain
	}
	switch {
	case opts.Chunks != nil && chain == "":
		checks.fail("chain", "The receipt carries no chain head, but stream events were supplied.")
	case opts.Chunks != nil:
		if _, head := ChunkChain(d.Claims.RID, opts.Chunks); head == chain {
			checks.pass("chain", fmt.Sprintf("chain head over %d events matches", len(opts.Chunks)))
		} else {
			checks.fail("chain", "The chain head does not match the events received: the stream was cut or altered.")
		}
	case chain != "":
		checks.skip("chain", "Supply the streamed events to check the chain head.")
	default:
		checks.skip("chain", "Not a streamed response.")
	}

	leaf := ReceiptLeafV2(b)
	anchor := AnchorNoProof
	if opts.Proof != nil && opts.Proof.Root != "" && opts.Proof.Proof != nil {
		if VerifyMerkleProof(leaf, opts.Proof.Proof, opts.Proof.Root) {
			anchor = AnchorProofValid
			checks.pass("anchor_proof", "leaf is under root "+opts.Proof.Root)
		} else {
			anchor = AnchorProofInvalid
			checks.fail("anchor_proof", "The Merkle path does not lead from this receipt to the root.")
		}
	} else {
		checks.skip("anchor_proof", "No proof supplied (roots are built hourly).")
	}
	claims := d.Claims
	return ReceiptV2Verification{Valid: checks.valid(), KeyID: d.KeyID, Claims: &claims, Leaf: leaf, Checks: checks, Anchor: anchor}
}
