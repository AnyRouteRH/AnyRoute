# Adapted from packages/client-py (Apache-2.0).
"""Canonical JSON, byte-for-byte what the router and the sidecar sign.

The router builds it with ``JSON.stringify`` over objects whose keys were sorted recursively, ``undefined`` dropped and
bigint turned into a string. This reproduces JavaScript's output exactly: key order by UTF-16 code units, string
escaping, and number formatting (Python's ``repr`` differs for exponents and for whole floats). One JavaScript quirk matters: an object's integer-like
keys iterate before all others, so the router's "sorted" output lists them first, in numeric order.
"""

from __future__ import annotations

import math
import re
from typing import Any

_ESC = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_MAX_SAFE = 2**53


def _string(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _ESC:
            out.append(_ESC[ch])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:  # control characters and lone surrogates are \u-escaped
            out.append(f"\\u{o:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_number(x: float) -> str:
    """ECMAScript Number::toString for a finite double; ``null`` for NaN and infinities like JSON.stringify."""
    if math.isnan(x) or math.isinf(x):
        return "null"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    m = re.fullmatch(r"(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?", repr(abs(x)))
    assert m is not None
    whole, frac, exp = m.group(1), m.group(2) or "", int(m.group(3) or 0)
    digits = (whole + frac).lstrip("0")
    s = digits.rstrip("0")
    k = len(s)
    # value = int(s) * 10**(trailing + exp - len(frac)), and ECMAScript's n satisfies value = int(s) * 10**(n - k)
    n = k + (len(digits) - k) + exp - len(frac)
    if k <= n <= 21:
        body = s + "0" * (n - k)
    elif 0 < n <= 21:
        body = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + s
    else:
        e = n - 1
        mant = s if k == 1 else s[0] + "." + s[1:]
        body = f"{mant}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


_INDEX = re.compile(r"0|[1-9][0-9]*")


def _ordered_keys(obj: dict) -> list:
    """The order JavaScript emits: keys that are array indices (canonical integers below 2**32 - 1) come first in
    numeric order whatever order they were inserted in, then the rest sorted by UTF-16 code unit."""
    keys = [str(k) for k in obj]
    index = sorted((k for k in keys if _INDEX.fullmatch(k) and int(k) < 2**32 - 1), key=int)
    rest = sorted((k for k in keys if not (_INDEX.fullmatch(k) and int(k) < 2**32 - 1)), key=lambda k: k.encode("utf-16-be", "surrogatepass"))
    return index + rest


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, int):
        return str(value) if abs(value) <= _MAX_SAFE else js_number(float(value))
    if isinstance(value, float):
        return js_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        strkeys = {str(k): k for k in value}
        return "{" + ",".join(_string(k) + ":" + canonical_json(value[strkeys[k]]) for k in _ordered_keys(value)) + "}"
    raise TypeError(f"cannot canonicalize {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8", "surrogatepass")
