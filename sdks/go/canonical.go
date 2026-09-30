package anyroute

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Canonical JSON is the text a v1 receipt signature covers: object keys sorted recursively (by UTF-16 code units, the
// way JavaScript sorts strings, except that integer keys such as "9" and "10" come first in numeric order, as they do
// in any JavaScript object), no whitespace, and numbers and strings written exactly as JavaScript's
// JSON.stringify writes them. Go's encoding/json differs in three ways that matter here (it escapes <, > and &, it
// formats floats differently and it replaces lone surrogates), so this file parses and writes JSON itself.

// CanonicalJSON returns the canonical JSON bytes of v. A json.RawMessage or []byte is taken as JSON text; any other
// value is first encoded with encoding/json.
func CanonicalJSON(v any) ([]byte, error) {
	var text []byte
	switch t := v.(type) {
	case json.RawMessage:
		text = t
	case []byte:
		text = t
	default:
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(v); err != nil {
			return nil, err
		}
		text = buf.Bytes()
	}
	p := &jsonParser{s: text}
	p.skipSpace()
	val, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.i != len(p.s) {
		return nil, fmt.Errorf("canonical json: trailing data at offset %d", p.i)
	}
	var out bytes.Buffer
	writeCanonical(&out, val)
	return out.Bytes(), nil
}

// Parsed values: nil, bool, float64, u16 (a string as UTF-16 code units), []any, *jsonObject.
type u16 []uint16

type jsonMember struct {
	key u16
	val any
}

type jsonObject struct{ members []jsonMember }

type jsonParser struct {
	s []byte
	i int
}

const maxJSONDepth = 512

func (p *jsonParser) skipSpace() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *jsonParser) fail(msg string) error {
	return fmt.Errorf("canonical json: %s at offset %d", msg, p.i)
}

func (p *jsonParser) value(depth int) (any, error) {
	if depth > maxJSONDepth {
		return nil, p.fail("nesting too deep")
	}
	if p.i >= len(p.s) {
		return nil, p.fail("unexpected end")
	}
	switch c := p.s[p.i]; {
	case c == '{':
		p.i++
		obj := &jsonObject{}
		index := map[string]int{}
		p.skipSpace()
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			return obj, nil
		}
		for {
			p.skipSpace()
			if p.i >= len(p.s) || p.s[p.i] != '"' {
				return nil, p.fail("expected object key")
			}
			k, err := p.str()
			if err != nil {
				return nil, err
			}
			p.skipSpace()
			if p.i >= len(p.s) || p.s[p.i] != ':' {
				return nil, p.fail("expected ':'")
			}
			p.i++
			p.skipSpace()
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			// Like JSON.parse, a repeated key keeps its last value.
			ks := string(utf16Bytes(k))
			if at, ok := index[ks]; ok {
				obj.members[at].val = v
			} else {
				index[ks] = len(obj.members)
				obj.members = append(obj.members, jsonMember{key: k, val: v})
			}
			p.skipSpace()
			if p.i >= len(p.s) {
				return nil, p.fail("unterminated object")
			}
			if p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.s[p.i] == '}' {
				p.i++
				return obj, nil
			}
			return nil, p.fail("expected ',' or '}'")
		}
	case c == '[':
		p.i++
		arr := []any{}
		p.skipSpace()
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return arr, nil
		}
		for {
			p.skipSpace()
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
			p.skipSpace()
			if p.i >= len(p.s) {
				return nil, p.fail("unterminated array")
			}
			if p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.s[p.i] == ']' {
				p.i++
				return arr, nil
			}
			return nil, p.fail("expected ',' or ']'")
		}
	case c == '"':
		return p.str()
	case c == 't':
		return true, p.literal("true")
	case c == 'f':
		return false, p.literal("false")
	case c == 'n':
		return nil, p.literal("null")
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	default:
		return nil, p.fail(fmt.Sprintf("unexpected character %q", c))
	}
}

func (p *jsonParser) literal(word string) error {
	if !bytes.HasPrefix(p.s[p.i:], []byte(word)) {
		return p.fail("invalid literal")
	}
	p.i += len(word)
	return nil
}

func (p *jsonParser) number() (any, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return nil, p.fail("invalid number")
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return nil, p.fail("invalid number")
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return nil, p.fail("invalid number")
		}
	}
	f, err := strconv.ParseFloat(string(p.s[start:p.i]), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, p.fail("invalid number")
	}
	return f, nil
}

func hexVal(b byte) (uint16, bool) {
	switch {
	case b >= '0' && b <= '9':
		return uint16(b - '0'), true
	case b >= 'a' && b <= 'f':
		return uint16(b-'a') + 10, true
	case b >= 'A' && b <= 'F':
		return uint16(b-'A') + 10, true
	}
	return 0, false
}

func (p *jsonParser) str() (u16, error) {
	p.i++ // opening quote
	out := u16{}
	for {
		if p.i >= len(p.s) {
			return nil, p.fail("unterminated string")
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return out, nil
		case c == '\\':
			if p.i+1 >= len(p.s) {
				return nil, p.fail("bad escape")
			}
			e := p.s[p.i+1]
			p.i += 2
			switch e {
			case '"', '\\', '/':
				out = append(out, uint16(e))
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'u':
				if p.i+4 > len(p.s) {
					return nil, p.fail("bad unicode escape")
				}
				var v uint16
				for k := 0; k < 4; k++ {
					h, ok := hexVal(p.s[p.i+k])
					if !ok {
						return nil, p.fail("bad unicode escape")
					}
					v = v<<4 | h
				}
				p.i += 4
				out = append(out, v)
			default:
				return nil, p.fail("bad escape")
			}
		case c < 0x20:
			return nil, p.fail("control character in string")
		case c < utf8.RuneSelf:
			out = append(out, uint16(c))
			p.i++
		default:
			r, size := utf8.DecodeRune(p.s[p.i:])
			p.i += size
			if r > 0xFFFF {
				a, b := utf16.EncodeRune(r)
				out = append(out, uint16(a), uint16(b))
			} else {
				out = append(out, uint16(r))
			}
		}
	}
}

func utf16Bytes(s u16) []byte {
	b := make([]byte, 2*len(s))
	for i, c := range s {
		b[2*i] = byte(c >> 8)
		b[2*i+1] = byte(c)
	}
	return b
}

func lessU16(a, b u16) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// arrayIndex reports whether k is a canonical array index ("0" to "4294967294"). A JavaScript object lists such keys
// first, in numeric order, before every other key, whatever order they were added in.
func arrayIndex(k u16) (uint64, bool) {
	if len(k) == 0 || len(k) > 10 || (k[0] == '0' && len(k) > 1) {
		return 0, false
	}
	var n uint64
	for _, c := range k {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, n < 4294967295
}

// lessKey is the order JSON.stringify writes the keys of an object built by inserting keys in sorted order.
func lessKey(a, b u16) bool {
	ai, aok := arrayIndex(a)
	bi, bok := arrayIndex(b)
	switch {
	case aok && bok:
		return ai < bi
	case aok != bok:
		return aok
	}
	return lessU16(a, b)
}

func writeCanonical(out *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if t {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case float64:
		out.WriteString(jsNumber(t))
	case u16:
		writeJSString(out, t)
	case []any:
		out.WriteByte('[')
		for i, x := range t {
			if i > 0 {
				out.WriteByte(',')
			}
			writeCanonical(out, x)
		}
		out.WriteByte(']')
	case *jsonObject:
		ms := append([]jsonMember(nil), t.members...)
		sort.SliceStable(ms, func(i, j int) bool { return lessKey(ms[i].key, ms[j].key) })
		out.WriteByte('{')
		for i, m := range ms {
			if i > 0 {
				out.WriteByte(',')
			}
			writeJSString(out, m.key)
			out.WriteByte(':')
			writeCanonical(out, m.val)
		}
		out.WriteByte('}')
	}
}

const lowerHex = "0123456789abcdef"

func writeJSString(out *bytes.Buffer, s u16) {
	out.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			out.WriteString(`\"`)
		case c == '\\':
			out.WriteString(`\\`)
		case c == '\b':
			out.WriteString(`\b`)
		case c == '\f':
			out.WriteString(`\f`)
		case c == '\n':
			out.WriteString(`\n`)
		case c == '\r':
			out.WriteString(`\r`)
		case c == '\t':
			out.WriteString(`\t`)
		case c < 0x20:
			out.WriteString(`\u00`)
			out.WriteByte(lowerHex[c>>4])
			out.WriteByte(lowerHex[c&0xF])
		case c >= 0xD800 && c <= 0xDBFF && i+1 < len(s) && s[i+1] >= 0xDC00 && s[i+1] <= 0xDFFF:
			out.WriteRune(utf16.DecodeRune(rune(c), rune(s[i+1])))
			i++
		case c >= 0xD800 && c <= 0xDFFF:
			// A lone surrogate: JSON.stringify writes it as an escape.
			out.WriteString(`\u`)
			out.WriteByte(lowerHex[c>>12])
			out.WriteByte(lowerHex[(c>>8)&0xF])
			out.WriteByte(lowerHex[(c>>4)&0xF])
			out.WriteByte(lowerHex[c&0xF])
		default:
			out.WriteRune(rune(c))
		}
	}
	out.WriteByte('"')
}

// jsNumber formats f the way JavaScript's Number.prototype.toString does (ECMA-262 Number::toString).
func jsNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		return "0"
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // shortest round-trip digits, e.g. "-1.2345e+29"
	neg := false
	if s[0] == '-' {
		neg = true
		s = s[1:]
	}
	mant, expPart, _ := strings.Cut(s, "e")
	e, _ := strconv.Atoi(expPart)
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	n := e + 1
	var r string
	switch {
	case k <= n && n <= 21:
		r = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		r = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		r = "0." + strings.Repeat("0", -n) + digits
	default:
		r = digits[:1]
		if k > 1 {
			r += "." + digits[1:]
		}
		x := n - 1
		if x < 0 {
			r += "e-" + strconv.Itoa(-x)
		} else {
			r += "e+" + strconv.Itoa(x)
		}
	}
	if neg {
		return "-" + r
	}
	return r
}
