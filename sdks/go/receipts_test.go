package anyroute

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// RFC 8032 Section 7.1 test 1 key. Public test material only.
const testSeedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
const testPubHex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
const testKid = "21fe31dfa154a261"

func testKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	seed, _ := hex.DecodeString(testSeedHex)
	return ed25519.NewKeyFromSeed(seed)
}

func testKeySet(t *testing.T) *KeySet {
	pub := testKey(t).Public().(ed25519.PublicKey)
	return &KeySet{Keys: []ReceiptKey{{Kty: "OKP", Crv: "Ed25519", X: base64.RawURLEncoding.EncodeToString(pub), Kid: KeyID(pub), ValidFrom: "2026-01-01T00:00:00Z"}}}
}

// signV1 builds a v1 receipt the way the router does: Ed25519 over canonical JSON, leaf over canonical || sig.
func signV1(t *testing.T, payload string) *Receipt {
	t.Helper()
	priv := testKey(t)
	canonical, err := CanonicalJSON(json.RawMessage(payload))
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, canonical)
	return &Receipt{
		ID:      "gen-1",
		Payload: json.RawMessage(payload),
		Sig:     base64.StdEncoding.EncodeToString(sig),
		KeyID:   KeyID(priv.Public().(ed25519.PublicKey)),
		Alg:     "Ed25519",
		Leaf:    ReceiptLeafV1(canonical, sig),
	}
}

const v1Payload = `{"v":1,"id":"gen-1","issued":"2026-09-15T10:00:00.000Z","model":"example/model","lane":"public",
 "tokens":{"prompt":3,"completion":4,"reasoning":0,"cached":0,"estimated":false},"cost":"0.00001","paid_with":null,
 "note":"<b>&amp;</b>","ratio":1.0,"big":1e21}`

func TestKeyID(t *testing.T) {
	pub, _ := hex.DecodeString(testPubHex)
	if got := KeyID(pub); got != testKid {
		t.Fatalf("KeyID = %s, want %s", got, testKid)
	}
	if hex.EncodeToString(testKey(t).Public().(ed25519.PublicKey)) != testPubHex {
		t.Fatal("seed does not give the RFC 8032 public key")
	}
}

func TestVerifyReceiptV1(t *testing.T) {
	r := signV1(t, v1Payload)
	v := VerifyReceiptV1(r, VerifyOptions{Keys: testKeySet(t)})
	if !v.Valid {
		t.Fatalf("valid receipt rejected: %+v", v.Checks)
	}
	for _, id := range []string{"alg", "key", "signature", "key_window", "leaf"} {
		if c, _ := v.Check(id); c.Status != CheckPass {
			t.Errorf("check %s = %s (%s)", id, c.Status, c.Detail)
		}
	}
	// The same receipt under a raw key.
	if v := VerifyReceiptV1(r, VerifyOptions{PublicKeyHex: testPubHex}); !v.Valid {
		t.Fatalf("raw key: %+v", v.Checks)
	}
	// Re-encoding the payload with different key order and spacing does not change the signed bytes.
	r2 := *r
	r2.Payload = json.RawMessage(`{"big":1E21,"ratio":1,"note":"<b>&amp;</b>","paid_with":null,"cost":"0.00001","tokens":{"estimated":false,"cached":0,"reasoning":0,"completion":4,"prompt":3},"lane":"public","model":"example/model","issued":"2026-09-15T10:00:00.000Z","id":"gen-1","v":1}`)
	if v := VerifyReceiptV1(&r2, VerifyOptions{Keys: testKeySet(t)}); !v.Valid {
		t.Fatalf("re-encoded payload rejected: %+v", v.Checks)
	}
}

func TestVerifyReceiptV1Tampered(t *testing.T) {
	r := signV1(t, v1Payload)
	bad := *r
	bad.Payload = json.RawMessage(strings.Replace(v1Payload, `"0.00001"`, `"0.00002"`, 1))
	v := VerifyReceiptV1(&bad, VerifyOptions{Keys: testKeySet(t)})
	if v.Valid {
		t.Fatal("tampered payload accepted")
	}
	if c, _ := v.Check("signature"); c.Status != CheckFail {
		t.Fatalf("signature check = %s", c.Status)
	}
	// Unknown key.
	other := *r
	other.KeyID = "0000000000000000"
	if v := VerifyReceiptV1(&other, VerifyOptions{Keys: testKeySet(t)}); v.Valid {
		t.Fatal("unknown key accepted")
	}
	// Wrong leaf.
	leaf := *r
	leaf.Leaf = "0x" + strings.Repeat("00", 32)
	if v := VerifyReceiptV1(&leaf, VerifyOptions{Keys: testKeySet(t)}); v.Valid {
		t.Fatal("wrong leaf accepted")
	}
	// A retired key does not cover a later receipt.
	ks := testKeySet(t)
	retired := "2026-02-01T00:00:00Z"
	ks.Keys[0].RetiredAt = &retired
	if v := VerifyReceiptV1(r, VerifyOptions{Keys: ks}); v.Valid {
		t.Fatal("receipt outside the key window accepted")
	}
}

func TestVerifyReceiptV1AnchorProof(t *testing.T) {
	r := signV1(t, v1Payload)
	leaf, _ := hexBytes(r.Leaf)
	sib := Keccak256([]byte("sibling"))
	var root []byte
	if bytes.Compare(leaf, sib) < 0 {
		root = Keccak256(leaf, sib)
	} else {
		root = Keccak256(sib, leaf)
	}
	r.Anchor = &AnchorProof{Root: "0x" + hex.EncodeToString(root), Proof: []string{"0x" + hex.EncodeToString(sib)}}
	v := VerifyReceiptV1(r, VerifyOptions{Keys: testKeySet(t)})
	if !v.Valid || v.Anchor != AnchorProofValid {
		t.Fatalf("anchor proof: %s %+v", v.Anchor, v.Checks)
	}
	r.Anchor.Root = "0x" + strings.Repeat("11", 32)
	if v := VerifyReceiptV1(r, VerifyOptions{Keys: testKeySet(t)}); v.Valid || v.Anchor != AnchorProofInvalid {
		t.Fatal("bad anchor proof accepted")
	}
}

type v2Fixture struct {
	PublicKeyHex string        `json:"public_key_hex"`
	KeyID        string        `json:"key_id"`
	COSE         string        `json:"cose"`
	Leaf         string        `json:"leaf"`
	Claims       ReceiptClaims `json:"claims"`
	Chunks       []string      `json:"chunks"`
	ChainSteps   []string      `json:"chain_steps"`
}

func loadV2Fixture(t *testing.T) v2Fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/receipt-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var f v2Fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestVerifyReceiptV2Fixture(t *testing.T) {
	f := loadV2Fixture(t)
	if f.PublicKeyHex != testPubHex || f.KeyID != testKid {
		t.Fatal("fixture key is not the RFC 8032 test key")
	}
	v := VerifyReceiptV2(f.COSE, VerifyV2Options{PublicKeyHex: f.PublicKeyHex, Chunks: f.Chunks})
	if !v.Valid {
		t.Fatalf("fixture rejected: %+v", v.Checks)
	}
	if v.KeyID != f.KeyID || v.Leaf != f.Leaf {
		t.Fatalf("kid %s leaf %s", v.KeyID, v.Leaf)
	}
	if c, _ := v.Check("chain"); c.Status != CheckPass {
		t.Fatalf("chain check: %+v", c)
	}
	if v.Claims.RID != f.Claims.RID || v.Claims.IAT != f.Claims.IAT || v.Claims.Resp.Chain != f.Claims.Resp.Chain || v.Claims.Credit.CostUnits != 812 {
		t.Fatalf("claims differ: %+v", v.Claims)
	}
	// Same result from raw bytes and from the published key set.
	b, _ := base64.StdEncoding.DecodeString(f.COSE)
	if v := VerifyReceiptV2(b, VerifyV2Options{Keys: testKeySet(t)}); !v.Valid {
		t.Fatalf("bytes + key set: %+v", v.Checks)
	}
	// The chain steps match the fixture.
	steps, head := ChunkChain(f.Claims.RID, f.Chunks)
	for i := range steps {
		if steps[i] != f.ChainSteps[i] {
			t.Fatalf("step %d = %s, want %s", i+1, steps[i], f.ChainSteps[i])
		}
	}
	if head != f.Claims.Resp.Chain {
		t.Fatalf("head %s", head)
	}
	// Anchor proof over the v2 leaf.
	leaf, _ := hexBytes(f.Leaf)
	sib := Keccak256([]byte("other receipt"))
	root := Keccak256(sib, leaf)
	if bytes.Compare(leaf, sib) < 0 {
		root = Keccak256(leaf, sib)
	}
	proof := &ReceiptProofResult{Root: "0x" + hex.EncodeToString(root), Proof: []string{"0x" + hex.EncodeToString(sib)}}
	if v := VerifyReceiptV2(f.COSE, VerifyV2Options{PublicKeyHex: testPubHex, Proof: proof}); !v.Valid || v.Anchor != AnchorProofValid {
		t.Fatalf("anchor: %s %+v", v.Anchor, v.Checks)
	}
}

func TestVerifyReceiptV2Tampered(t *testing.T) {
	f := loadV2Fixture(t)
	b, _ := base64.StdEncoding.DecodeString(f.COSE)

	// Flip one byte inside the claims (the model id text).
	i := bytes.Index(b, []byte("example/model"))
	if i < 0 {
		t.Fatal("model id not found in the COSE bytes")
	}
	bad := append([]byte(nil), b...)
	bad[i] = 'E'
	v := VerifyReceiptV2(bad, VerifyV2Options{PublicKeyHex: testPubHex})
	if v.Valid {
		t.Fatal("tampered claims accepted")
	}
	if c, _ := v.Check("signature"); c.Status != CheckFail {
		t.Fatalf("signature check = %+v", c)
	}

	// Flip a signature byte.
	sig := append([]byte(nil), b...)
	sig[len(sig)-1] ^= 1
	if v := VerifyReceiptV2(sig, VerifyV2Options{PublicKeyHex: testPubHex}); v.Valid {
		t.Fatal("tampered signature accepted")
	}

	// A dropped stream event fails the chain.
	if v := VerifyReceiptV2(f.COSE, VerifyV2Options{PublicKeyHex: testPubHex, Chunks: f.Chunks[:2]}); v.Valid {
		t.Fatal("cut stream accepted")
	}

	// A different key fails.
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32)).Public().(ed25519.PublicKey)
	if v := VerifyReceiptV2(f.COSE, VerifyV2Options{PublicKey: other}); v.Valid {
		t.Fatal("wrong key accepted")
	}

	// Garbage is reported, not panicked on.
	for _, junk := range [][]byte{nil, {0xd2}, {0xd2, 0x84, 0x40}, bytes.Repeat([]byte{0x9f}, 10), b[:len(b)/2]} {
		if v := VerifyReceiptV2(junk, VerifyV2Options{PublicKeyHex: testPubHex}); v.Valid {
			t.Fatalf("junk %x accepted", junk)
		}
	}
	if v := VerifyReceiptV2("not base64 !!", VerifyV2Options{PublicKeyHex: testPubHex}); v.Valid {
		t.Fatal("bad base64 accepted")
	}
}

func TestCheckChain(t *testing.T) {
	f := loadV2Fixture(t)
	events := make([]ChainedEvent, len(f.Chunks))
	for i := range f.Chunks {
		events[i] = ChainedEvent{Data: f.Chunks[i], Chain: f.ChainSteps[i]}
	}
	if r := CheckChain(f.Claims.RID, events); !r.OK || r.Head != f.Claims.Resp.Chain {
		t.Fatalf("%+v", r)
	}
	events[1].Data = strings.Replace(events[1].Data, "lo", "LO", 1)
	if r := CheckChain(f.Claims.RID, events); r.OK || r.FirstMismatch != 2 {
		t.Fatalf("altered event: %+v", r)
	}
}
