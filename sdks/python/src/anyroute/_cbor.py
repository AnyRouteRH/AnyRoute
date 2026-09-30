"""A minimal CBOR (RFC 8949) decoder: the subset receipt v2 uses.

Definite lengths only. Indefinite lengths, trailing bytes and truncated input are errors. Floats and the simple
values false, true and null decode; tags come back as ``CborTag``.
"""

from __future__ import annotations

import struct
from typing import Any, NamedTuple

__all__ = ["CborError", "CborTag", "loads", "head", "bstr", "tstr"]

_MAX_DEPTH = 64


class CborError(ValueError):
    """The bytes are not well formed CBOR (or use a feature this decoder does not support)."""


class CborTag(NamedTuple):
    tag: int
    value: Any


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.at = 0

    def take(self, n: int) -> bytes:
        if n < 0 or self.at + n > len(self.data):
            raise CborError("cbor: truncated")
        out = self.data[self.at : self.at + n]
        self.at += n
        return out

    def item(self, depth: int = 0) -> Any:
        if depth > _MAX_DEPTH:
            raise CborError("cbor: nested too deeply")
        b = self.take(1)[0]
        major, info = b >> 5, b & 0x1F
        if major == 7:
            if info == 20:
                return False
            if info == 21:
                return True
            if info == 22:
                return None
            if info == 25:
                return struct.unpack(">e", self.take(2))[0]
            if info == 26:
                return struct.unpack(">f", self.take(4))[0]
            if info == 27:
                return struct.unpack(">d", self.take(8))[0]
            raise CborError(f"cbor: unsupported simple value {info}")
        if info < 24:
            n = info
        elif info in (24, 25, 26, 27):
            n = int.from_bytes(self.take(1 << (info - 24)), "big")
        else:
            raise CborError("cbor: indefinite lengths are not allowed")
        if major == 0:
            return n
        if major == 1:
            return -1 - n
        if major == 2:
            return self.take(n)
        if major == 3:
            try:
                return self.take(n).decode("utf-8")
            except UnicodeDecodeError as e:
                raise CborError("cbor: text string is not valid UTF-8") from e
        if major == 4:
            return [self.item(depth + 1) for _ in range(n)]
        if major == 5:
            out: dict[Any, Any] = {}
            for _ in range(n):
                k = self.item(depth + 1)
                if isinstance(k, (list, dict)):
                    raise CborError("cbor: map keys must be scalars")
                out[k] = self.item(depth + 1)
            return out
        return CborTag(n, self.item(depth + 1))  # major 6


def loads(data: bytes) -> Any:
    """Decode exactly one CBOR item from ``data``."""
    r = _Reader(bytes(data))
    value = r.item()
    if r.at != len(r.data):
        raise CborError("cbor: trailing bytes")
    return value


def head(major: int, n: int) -> bytes:
    """The shortest (canonical) initial byte(s) for a major type and length or value."""
    if n < 24:
        return bytes([(major << 5) | n])
    if n < 0x100:
        return bytes([(major << 5) | 24, n])
    if n < 0x10000:
        return bytes([(major << 5) | 25]) + n.to_bytes(2, "big")
    if n < 0x100000000:
        return bytes([(major << 5) | 26]) + n.to_bytes(4, "big")
    return bytes([(major << 5) | 27]) + n.to_bytes(8, "big")


def bstr(b: bytes) -> bytes:
    return head(2, len(b)) + b


def tstr(s: str) -> bytes:
    raw = s.encode("utf-8")
    return head(3, len(raw)) + raw
