"""Lanes and disclosure ceilings.

A lane says how a request may be served: ``public`` (any endpoint), ``attested`` (a hardware attested endpoint) or
``unlinkable`` (attested, and not linkable to your account). A disclosure ceiling caps what the serving endpoint may
reveal: ``any``, ``policy`` or ``none``.

Both travel as headers (``X-Anyroute-Lane``, ``X-Anyroute-Disclosure-Max``) and in ``body.provider``. The router
applies the stricter of the two, and so does this SDK when it merges: a stricter value already in the body is never
loosened.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional

__all__ = [
    "LANES",
    "DISCLOSURES",
    "LANE_HEADER",
    "DISCLOSURE_HEADER",
    "Lane",
    "Disclosure",
    "check_lane",
    "check_disclosure",
    "stricter_lane",
    "stricter_disclosure",
    "merge_provider",
]

Lane = Literal["public", "attested", "unlinkable"]
Disclosure = Literal["any", "policy", "none"]

LANES: tuple[str, ...] = ("public", "attested", "unlinkable")
DISCLOSURES: tuple[str, ...] = ("any", "policy", "none")
LANE_HEADER = "X-Anyroute-Lane"
DISCLOSURE_HEADER = "X-Anyroute-Disclosure-Max"


def check_lane(lane: Optional[str]) -> Optional[str]:
    if lane is None:
        return None
    if lane not in LANES:
        raise ValueError(f"unknown lane {lane!r}: expected one of {', '.join(LANES)}")
    return lane


def check_disclosure(disclosure: Optional[str]) -> Optional[str]:
    if disclosure is None:
        return None
    if disclosure not in DISCLOSURES:
        raise ValueError(f"unknown disclosure ceiling {disclosure!r}: expected one of {', '.join(DISCLOSURES)}")
    return disclosure


def _strictest(order: tuple[str, ...], *values: Optional[str]) -> Optional[str]:
    known = [v for v in values if v in order]
    return max(known, key=order.index) if known else None


def stricter_lane(*lanes: Optional[str]) -> Optional[str]:
    """The strictest of the given lanes (public < attested < unlinkable); None values and unknown values are ignored."""
    return _strictest(LANES, *lanes)


def stricter_disclosure(*values: Optional[str]) -> Optional[str]:
    """The strictest of the given ceilings (any < policy < none)."""
    return _strictest(DISCLOSURES, *values)


def merge_provider(body: Mapping[str, Any], lane: Optional[str] = None, disclosure: Optional[str] = None) -> dict[str, Any]:
    """Return a copy of ``body`` whose ``provider.lane`` / ``provider.disclosure`` are at least as strict as the
    given values. A value already in the body that is stricter (or that this SDK does not know) is kept."""
    out = dict(body)
    if lane is None and disclosure is None:
        return out
    provider = dict(out.get("provider") or {})
    for key, value, order in (("lane", lane, LANES), ("disclosure", disclosure, DISCLOSURES)):
        if value is None:
            continue
        current = provider.get(key)
        if current is None or (current in order and order.index(value) > order.index(current)):
            provider[key] = value
    out["provider"] = provider
    return out
