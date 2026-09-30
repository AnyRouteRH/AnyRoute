package anyroute

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestKeccak256Vectors(t *testing.T) {
	cases := map[string]string{
		"":    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
		"abc": "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
		"The quick brown fox jumps over the lazy dog": "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
	}
	for in, want := range cases {
		if got := hex.EncodeToString(Keccak256([]byte(in))); got != want {
			t.Errorf("keccak256(%q) = %s, want %s", in, got, want)
		}
	}
	// Inputs across the 136-byte block boundary, fed whole and in pieces, must agree.
	for _, n := range []int{135, 136, 137, 272, 1000} {
		data := bytes.Repeat([]byte{0xab}, n)
		whole := Keccak256(data)
		split := Keccak256(data[:n/3], data[n/3:])
		if !bytes.Equal(whole, split) {
			t.Errorf("keccak256 of %d bytes differs when split", n)
		}
	}
}

func TestCanonicalVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/canonical-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Input    string `json:"input"`
		Expected string `json:"expected"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 40 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for _, v := range vectors {
		got, err := CanonicalJSON(json.RawMessage(v.Input))
		if err != nil {
			t.Errorf("CanonicalJSON(%q): %v", v.Input, err)
			continue
		}
		if string(got) != v.Expected {
			t.Errorf("CanonicalJSON(%q)\n got  %q\n want %q", v.Input, got, v.Expected)
		}
	}
}

func TestCanonicalFromGoValues(t *testing.T) {
	got, err := CanonicalJSON(map[string]any{"b": "<a&b>", "a": 1.5, "c": []int{3, 1}})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"a":1.5,"b":"<a&b>","c":[3,1]}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
	if _, err := CanonicalJSON(json.RawMessage(`{"a":1,}`)); err == nil {
		t.Fatal("expected an error for invalid JSON")
	}
}

func TestMerkleProof(t *testing.T) {
	leaf := Keccak256([]byte("leaf"))
	s1 := Keccak256([]byte("s1"))
	s2 := Keccak256([]byte("s2"))
	pair := func(a, b []byte) []byte {
		if bytes.Compare(a, b) < 0 {
			return Keccak256(a, b)
		}
		return Keccak256(b, a)
	}
	root := pair(pair(leaf, s1), s2)
	h := func(b []byte) string { return "0x" + hex.EncodeToString(b) }
	if !VerifyMerkleProof(h(leaf), []string{h(s1), h(s2)}, h(root)) {
		t.Fatal("valid proof rejected")
	}
	if VerifyMerkleProof(h(leaf), []string{h(s2), h(s1)}, h(root)) {
		t.Fatal("proof in the wrong order accepted")
	}
	if VerifyMerkleProof(h(s1), []string{h(leaf)}, h(root)) {
		t.Fatal("wrong leaf accepted")
	}
	if VerifyMerkleProof("0xzz", nil, h(root)) {
		t.Fatal("bad hex accepted")
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	if d := parseRetryAfter("7", now); d != 7*time.Second {
		t.Errorf("seconds: %v", d)
	}
	if d := parseRetryAfter("1.5", now); d != 1500*time.Millisecond {
		t.Errorf("fractional seconds: %v", d)
	}
	date := now.Add(30 * time.Second).Format(http.TimeFormat)
	if d := parseRetryAfter(date, now); d != 30*time.Second {
		t.Errorf("http date: %v", d)
	}
	if d := parseRetryAfter("soon", now); d != 0 {
		t.Errorf("garbage: %v", d)
	}
}

func TestJSNumber(t *testing.T) {
	cases := map[float64]string{0: "0", -1.5: "-1.5", 1e21: "1e+21", 1e20: "100000000000000000000", 1e-7: "1e-7", 123e-20: "1.23e-18", 0.5: "0.5", -1e-7: "-1e-7"}
	for f, want := range cases {
		if got := jsNumber(f); got != want {
			t.Errorf("jsNumber(%v) = %s, want %s", f, got, want)
		}
	}
}
