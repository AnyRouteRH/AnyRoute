"""Reader for an Intel TDX version 4 quote: a 48-byte header, then the 584-byte TD report body.

It reads fields; it does not check the quote signature or its certificate chain.
"""

from __future__ import annotations

from dataclasses import dataclass

_HEADER = 48
_BODY = 584


@dataclass(frozen=True)
class TdxFields:
    version: int
    tee_type: int
    mrtd: str
    rtmr0: str
    rtmr1: str
    rtmr2: str
    rtmr3: str
    report_data: str


def parse_tdx_quote(quote: bytes) -> TdxFields:
    if len(quote) < _HEADER + _BODY:
        raise ValueError(f"TDX quote too short ({len(quote)} bytes)")
    version = int.from_bytes(quote[0:2], "little")
    if version != 4:
        raise ValueError(f"unsupported TDX quote version {version} (this reader handles version 4)")
    tee_type = int.from_bytes(quote[4:8], "little")
    if tee_type != 0x81:
        raise ValueError(f"not a TDX quote (tee type 0x{tee_type:x})")

    def at(off: int, n: int) -> str:
        return quote[_HEADER + off : _HEADER + off + n].hex()

    return TdxFields(version, tee_type, at(136, 48), at(328, 48), at(376, 48), at(424, 48), at(472, 48), at(520, 64))
