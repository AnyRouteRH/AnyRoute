"""A fake Anyroute router behind httpx.MockTransport. Nothing here touches the network.

Receipts are real: v1 receipts are signed on the fly with the RFC 8032 section 7.1 test 1 key, and the v2 part is the
cross-language fixture (signed with the same key), so verification runs end to end.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from anyroute import Anyroute, AsyncAnyroute
from anyroute._canonical import canonical_bytes
from anyroute._keccak import keccak256
from anyroute.receipts import receipt_leaf_v1

FIXTURES = Path(__file__).parent / "fixtures"
V2 = json.loads((FIXTURES / "receipt-v2.json").read_text())
SECRET = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
SK = Ed25519PrivateKey.from_private_bytes(SECRET)
PUB_HEX = V2["public_key_hex"]
KID = V2["key_id"]
RID = V2["claims"]["rid"]
BASE = "https://router.test"
API_KEY = "sk-test-123"
SIBLING = "0x" + "ab" * 32


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def sign_v1(payload: dict[str, Any], rid: str = RID) -> dict[str, Any]:
    canonical = canonical_bytes(payload)
    sig = SK.sign(canonical)
    return {"id": rid, "sig": b64(sig), "key_id": KID, "alg": "Ed25519", "payload": payload, "leaf": receipt_leaf_v1(canonical, sig), "anchor_hint": "hourly"}


def v1_payload(rid: str = RID, **extra: Any) -> dict[str, Any]:
    return {"type": "anyroute.receipt", "v": 1, "rid": rid, "model": "example/model", "ts": 1790000000000, "tokens": {"in": 12, "out": 3}, "cost": 0.000812, **extra}


def make_receipt(rid: str = RID, *, v2: bool = True) -> dict[str, Any]:
    r = sign_v1(v1_payload(rid), rid)
    if v2:
        r["v2"] = {"alg": "EdDSA", "kid": KID, "content_type": "application/cose; cose-type=cose-sign1", "cose": V2["cose"], "claims": V2["claims"], "leaf": V2["leaf"]}
    return r


def merkle_root(leaf: str, sibling: str) -> str:
    a, b = bytes.fromhex(leaf[2:]), bytes.fromhex(sibling[2:])
    x, y = (a, b) if a < b else (b, a)
    return "0x" + keccak256(x + y).hex()


def err(status: int, message: str, type_: str, headers: dict[str, str] | None = None, metadata: dict[str, Any] | None = None) -> httpx.Response:
    e: dict[str, Any] = {"code": status, "message": message, "type": type_}
    if metadata:
        e["metadata"] = metadata
    return httpx.Response(status, json={"error": e}, headers=headers or {})


MODELS = [
    {"id": "example/chat", "name": "Chat", "lanes": ["public"], "attested_available": False, "architecture": {"output_modalities": ["text"]}},
    {"id": "example/private-chat", "name": "Private chat", "lanes": ["public", "attested", "unlinkable"], "attested_available": True, "architecture": {"output_modalities": ["text"]}},
    {"id": "example/attested-chat", "name": "Attested chat", "lanes": ["public", "attested"], "attested_available": True, "architecture": {"output_modalities": ["text"]}},
    {"id": "example/reranker", "name": "Reranker", "lanes": ["public"], "architecture": {"output_modalities": ["rerank"]}},
]


class FakeRouter:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.presets: dict[str, list[dict[str, Any]]] = {}
        self.batches: dict[str, dict[str, Any]] = {}
        self.batch_requests: dict[str, list[dict[str, Any]]] = {}
        self.tamper_stream = False
        self.key_fetches = 0
        self.fail_connect = False

    # ---- helpers -------------------------------------------------------------------------------------------------

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def last_to(self, path: str) -> httpx.Request:
        return next(r for r in reversed(self.requests) if r.url.path == path)

    @staticmethod
    def body(request: httpx.Request) -> Any:
        return json.loads(request.content) if request.content else None

    def gen_headers(self, request: httpx.Request) -> dict[str, str]:
        return {
            "x-generation-id": RID,
            "x-receipt-id": RID,
            "x-anyroute-lane": request.headers.get("x-anyroute-lane", "public"),
            "x-anyroute-disclosure": "vendor-forwarded",
            "x-anyroute-policy-hash": "0x" + "cd" * 32,
        }

    # ---- the router ----------------------------------------------------------------------------------------------

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail_connect:
            raise httpx.ConnectError("connection refused", request=request)
        path, method = request.url.path, request.method
        if path == "/.well-known/anyroute-receipt-keys.json":
            self.key_fetches += 1
            return httpx.Response(200, json={"keys": [{"kty": "OKP", "crv": "Ed25519", "x": b64url(bytes.fromhex(PUB_HEX)), "kid": KID, "valid_from": "2025-01-01T00:00:00Z", "retired_at": None}]})
        if request.headers.get("authorization") != f"Bearer {API_KEY}":
            return err(401, "Missing or invalid API key.", "unauthorized")
        if not path.startswith("/api/v1/"):
            return err(404, "Not found", "not_found")
        parts = path[len("/api/v1/") :].split("/")
        body = self.body(request)

        if parts == ["chat", "completions"] and method == "POST":
            return self.chat(request, body)
        if parts == ["embeddings"] and method == "POST":
            data = [{"object": "embedding", "index": i, "embedding": [0.1 * (i + 1), 0.2, 0.3]} for i, _ in enumerate(body["input"] if isinstance(body["input"], list) else [body["input"]])]
            return httpx.Response(200, json={"object": "list", "model": body["model"], "data": data, "usage": {"prompt_tokens": 4, "total_tokens": 4}, "receipt": make_receipt(v2=False)}, headers=self.gen_headers(request))
        if parts == ["rerank"] and method == "POST":
            docs = body["documents"]
            scored = sorted(((i, 1.0 / (1 + abs(len(d if isinstance(d, str) else d["text"]) - len(body["query"])))) for i, d in enumerate(docs)), key=lambda t: -t[1])
            results = [{"index": i, "relevance_score": s, **({"document": {"text": docs[i] if isinstance(docs[i], str) else docs[i]["text"]}} if body.get("return_documents") else {})} for i, s in scored[: body.get("top_n") or len(docs)]]
            return httpx.Response(200, json={"id": RID, "model": body["model"], "results": results, "usage": {"total_tokens": 20, "search_units": 1, "cost": 0.00002}, "cost": 0.00002, "receipt": make_receipt(v2=False)}, headers=self.gen_headers(request))
        if parts[0] == "batches":
            return self.batch_route(method, parts[1:], body, request)
        if parts[0] == "presets":
            return self.preset_route(method, parts[1:], body, request)
        if parts == ["models"] and method == "GET":
            wanted = request.url.params.get("output_modalities")
            data = [m for m in MODELS if not wanted or set(wanted.split(",")) & set(m["architecture"]["output_modalities"])]
            return httpx.Response(200, json={"data": data})
        if parts[0] == "receipts" and method == "GET":
            rid = parts[1]
            if rid != RID:
                return err(404, f"Receipt {rid} not found", "receipt_not_found")
            if len(parts) == 3 and parts[2] == "proof":
                return httpx.Response(200, json={"data": {"rid": rid, "leaf": V2["leaf"], "leaf_version": 2, "rooted": True, "anchored": False, "root": merkle_root(V2["leaf"], SIBLING), "proof": [SIBLING], "status": "rooted"}})
            r = make_receipt(rid)
            return httpx.Response(200, json={"data": {**{k: r[k] for k in ("id", "payload", "sig", "key_id", "leaf")}, "version": 2, "anchor": None, "v2": {**r["v2"], "anchor": None}, "privacy": {"stored": "hashes only"}}})
        return err(404, f"No route for {method} {path}", "not_found")

    def chat(self, request: httpx.Request, body: dict[str, Any]) -> httpx.Response:
        if body.get("model") == "busy/model":
            return err(429, "Rate limit exceeded, slow down.", "rate_limited", headers={"Retry-After": "7"}, metadata={"limit": 60})
        if body.get("model") == "broken/model":
            return err(502, "Every endpoint failed.", "upstream_error")
        if body.get("model") == "missing/model":
            return err(404, "Model missing/model is not available.", "model_not_found")
        if not body.get("messages"):
            return err(400, "messages is required", "invalid_request")
        if body.get("stream"):
            return self.sse(request)
        return httpx.Response(
            200,
            json={
                "id": RID,
                "object": "chat.completion",
                "created": 1790000000,
                "model": body["model"],
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
                "receipt": make_receipt(),
            },
            headers=self.gen_headers(request),
        )

    def sse(self, request: httpx.Request) -> httpx.Response:
        chunks = list(V2["chunks"])
        if self.tamper_stream:
            chunks[1] = chunks[1].replace('"lo"', '"LO"')
        out = ": keep-alive\n\n"
        for i, data in enumerate(chunks, 1):
            out += f"data: {data}\n\n: anyroute-chain {i} {V2['chain_steps'][i - 1]}\n\n"
        out += "data: " + json.dumps({"receipt": make_receipt()}) + "\n\ndata: [DONE]\n\n"
        return httpx.Response(200, content=out.encode(), headers={**self.gen_headers(request), "content-type": "text/event-stream"})

    # ---- batches -------------------------------------------------------------------------------------------------

    def batch_route(self, method: str, rest: list[str], body: Any, request: httpx.Request) -> httpx.Response:
        if not rest and method == "POST":
            reqs = body.get("requests") or []
            if not reqs:
                return err(400, "requests is required", "invalid_request")
            bid = f"batch_{len(self.batches) + 1}"
            b = {"id": bid, "object": "batch", "endpoint": body.get("endpoint") or "/v1/chat/completions", "status": "validating", "created_at": 1790000000, "output_url": None, "errors_url": None, "request_counts": {"total": len(reqs), "completed": 0, "failed": 0}, "cost": {"usd": 0, "list_usd": 0, "discount_bps": 5000}, "metadata": body.get("metadata")}
            self.batches[bid] = b
            self.batch_requests[bid] = reqs
            return httpx.Response(200, json=b)
        if not rest and method == "GET":
            items = sorted(self.batches.values(), key=lambda b: b["id"], reverse=True)
            after = request.url.params.get("after")
            if after:
                items = [b for b in items if b["id"] < after]
            limit = int(request.url.params.get("limit") or 20)
            page = items[:limit]
            return httpx.Response(200, json={"object": "list", "data": page, "first_id": page[0]["id"] if page else None, "last_id": page[-1]["id"] if page else None, "has_more": len(items) > limit})
        bid = rest[0]
        b = self.batches.get(bid)
        if b is None:
            return err(404, f"Batch {bid} not found", "batch_not_found")
        if len(rest) == 1 and method == "GET":
            # each poll moves the batch one step along
            nxt = {"validating": "in_progress", "in_progress": "finalizing", "finalizing": "completed"}.get(b["status"])
            if nxt:
                b["status"] = nxt
                if nxt == "completed":
                    reqs = self.batch_requests[bid]
                    bad = sum(1 for r in reqs if r["custom_id"].startswith("bad"))
                    b["request_counts"] = {"total": len(reqs), "completed": len(reqs) - bad, "failed": bad}
                    b["output_url"] = f"/api/v1/batches/{bid}/output"
                    b["errors_url"] = f"/api/v1/batches/{bid}/errors" if bad else None
            return httpx.Response(200, json=b)
        if rest[1:] == ["cancel"] and method == "POST":
            b["status"] = "cancelled"
            return httpx.Response(200, json=b)
        if rest[1:] in (["output"], ["errors"]) and method == "GET":
            lines = []
            for i, r in enumerate(self.batch_requests[bid]):
                bad = r["custom_id"].startswith("bad")
                if (rest[1] == "errors") != bad:
                    continue
                if bad:
                    lines.append({"id": f"req_{i}", "custom_id": r["custom_id"], "response": None, "error": {"code": "model_not_found", "message": "no such model"}})
                else:
                    lines.append({"id": f"req_{i}", "custom_id": r["custom_id"], "response": {"status_code": 200, "request_id": f"gen-{i}", "body": {"choices": [{"message": {"content": f"answer {i}"}}]}}, "error": None})
            text = "".join(json.dumps(line) + "\n" for line in lines)
            return httpx.Response(200, content=text.encode(), headers={"content-type": "application/jsonl"})
        return err(404, "Not found", "not_found")

    # ---- presets -------------------------------------------------------------------------------------------------

    def _preset(self, name: str, v: dict[str, Any]) -> dict[str, Any]:
        return {"name": name, "model": f"@preset/{name}", "description": v["config"].get("description"), "version": v["version"], "hash": v["hash"], "config": v["config"], "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z"}

    def preset_route(self, method: str, rest: list[str], body: Any, request: httpx.Request) -> httpx.Response:
        if not rest and method == "GET":
            return httpx.Response(200, json={"data": [self._preset(n, vs[-1]) for n, vs in sorted(self.presets.items())], "limit": 100, "limits": {"presets": 100, "versions": 50}})
        name = rest[0]
        versions = self.presets.get(name)
        if len(rest) == 1 and method == "PUT":
            if not body.get("models"):
                return err(422, "models must be a non-empty array", "invalid_request")
            cfg = dict(body)
            h = "sha256:" + format(abs(hash(json.dumps(cfg, sort_keys=True))), "x")
            vs = self.presets.setdefault(name, [])
            changed = not vs or vs[-1]["config"] != cfg
            if changed:
                vs.append({"version": len(vs) + 1, "hash": h, "config": cfg})
            return httpx.Response(200, json={"data": {**self._preset(name, vs[-1]), "changed": changed}})
        if versions is None:
            return err(404, f"Preset {name} not found", "preset_not_found")
        if len(rest) == 1 and method == "GET":
            want = request.url.params.get("version")
            v = versions[-1] if not want else next((x for x in versions if str(x["version"]) == want.lstrip("v")), None)
            if v is None:
                return err(404, f"Preset {name} has no version {want}", "preset_version_not_found")
            return httpx.Response(200, json={"data": {**self._preset(name, v), "latest_version": versions[-1]["version"]}})
        if len(rest) == 1 and method == "DELETE":
            del self.presets[name]
            return httpx.Response(200, json={"data": {"name": name, "model": f"@preset/{name}", "deleted": True, "versions": len(versions)}})
        if rest[1:] == ["versions"]:
            return httpx.Response(200, json={"data": [{"version": v["version"], "hash": v["hash"], "model": f"@preset/{name}@{v['version']}", "source": "put", "created_at": "2026-09-01T00:00:00Z"} for v in reversed(versions)], "latest": versions[-1]["version"], "limit": 50})
        if rest[1:] == ["diff"]:
            f, t = int(request.url.params.get("from", 1)), int(request.url.params.get("to", versions[-1]["version"]))
            a, b = versions[f - 1]["config"], versions[t - 1]["config"]
            changes = [{"path": k, "from": a.get(k), "to": b.get(k)} for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
            return httpx.Response(200, json={"data": {"name": name, "from": f, "to": t, "identical": not changes, "changes": changes}})
        if rest[1:] == ["rollback"] and method == "POST":
            src = versions[int(body["version"]) - 1]
            versions.append({"version": len(versions) + 1, "hash": src["hash"], "config": dict(src["config"])})
            return httpx.Response(200, json={"data": {**self._preset(name, versions[-1]), "changed": True, "restored_from": src["version"]}})
        return err(404, "Not found", "not_found")


@pytest.fixture
def router() -> FakeRouter:
    return FakeRouter()


@pytest.fixture
def client(router: FakeRouter):
    with Anyroute(API_KEY, base_url=BASE, http_client=httpx.Client(transport=httpx.MockTransport(router))) as c:
        yield c


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def aclient(router: FakeRouter):
    async with AsyncAnyroute(API_KEY, base_url=BASE, http_client=httpx.AsyncClient(transport=httpx.MockTransport(router))) as c:
        yield c
