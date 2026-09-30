"""The synchronous client."""

from __future__ import annotations

import time
from typing import Any, Mapping, Optional, Sequence, Union

import httpx

from . import _base
from ._base import BaseClient, KeyCache, drop_none, seg
from ._streaming import ChatStream
from .errors import NotFoundError, error_from_response
from .receipts import Keys, ReceiptVerification, verify_receipt
from .types import AnyrouteMeta, Batch, BatchResults, ChatCompletion, DataList, Embeddings, Model, Rerank, APIResponse

__all__ = ["Anyroute"]


class Anyroute(BaseClient):
    """The Anyroute client (synchronous, on ``httpx.Client``).

    ``api_key`` defaults to ``$ANYROUTE_API_KEY`` and ``base_url`` to ``$ANYROUTE_BASE_URL`` or the public router.
    ``lane`` / ``disclosure`` apply to every request (a per-call value can only make them stricter).
    Pass ``http_client`` to reuse your own ``httpx.Client`` (proxies, transports, test doubles).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        http_client: Optional[httpx.Client] = None,
        default_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        super().__init__(api_key=api_key, base_url=base_url, lane=lane, disclosure=disclosure, timeout=timeout, default_headers=default_headers)
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout if timeout is not None else _base.DEFAULT_TIMEOUT)
        self.chat = Chat(self)
        self.embeddings = EmbeddingsResource(self)
        self.rerank = RerankResource(self)
        self.batches = Batches(self)
        self.presets = Presets(self)
        self.models = Models(self)
        self.receipts = Receipts(self)

    # ---- lifecycle -------------------------------------------------------------------------------------------------

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> "Anyroute":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def copy(self, **overrides: Any) -> "Anyroute":
        """A new client with some settings changed. It shares this client's connection pool and key cache."""
        opts = dict(api_key=self.api_key, base_url=self.base_url, lane=self.lane, disclosure=self.disclosure, timeout=self.timeout, default_headers=self.default_headers)
        opts.update(overrides)
        clone = Anyroute(http_client=self._http, **opts)
        clone._keys = self._keys if opts["base_url"] == self.base_url else KeyCache()
        return clone

    def with_lane(self, lane: Optional[str], disclosure: Optional[str] = None) -> "Anyroute":
        """A copy of this client that sends every request on ``lane`` (and, if given, under ``disclosure``)."""
        return self.copy(lane=lane, disclosure=disclosure if disclosure is not None else self.disclosure)

    # ---- transport -------------------------------------------------------------------------------------------------

    def _send(self, request: httpx.Request, *, stream: bool = False) -> httpx.Response:
        try:
            response = self._http.send(request, stream=stream)
        except httpx.TransportError as e:
            raise _base.wrap_transport_error(e) from e
        if response.status_code >= 400:
            if stream:
                try:
                    response.read()
                finally:
                    response.close()
            raise error_from_response(response)
        return response

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        return self._send(self._build(self._http, method, path, **kwargs))

    def _stream(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        return self._send(self._build(self._http, method, path, accept="text/event-stream", **kwargs), stream=True)


class _Resource:
    def __init__(self, client: Anyroute) -> None:
        self._client = client


class Completions(_Resource):
    def create(
        self,
        *,
        model: Optional[str] = None,
        messages: Sequence[Mapping[str, Any]],
        stream: bool = False,
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        extra_body: Optional[Mapping[str, Any]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> Union[ChatCompletion, ChatStream]:
        """``POST /api/v1/chat/completions``. Any OpenAI parameter goes through as a keyword (temperature, tools, ...).
        With ``stream=True`` this returns a ``ChatStream`` (same as ``stream()``)."""
        if stream:
            return self.stream(model=model, messages=messages, provider=provider, lane=lane, disclosure=disclosure, extra_headers=extra_headers, extra_body=extra_body, timeout=timeout, **params)
        body = _base.chat_body(model, messages, provider, params, extra_body)
        r = self._client._request("POST", "/chat/completions", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        data = _base.json_body(r)
        return ChatCompletion(data, meta=AnyrouteMeta.from_response(r.headers, data))

    def stream(
        self,
        *,
        model: Optional[str] = None,
        messages: Sequence[Mapping[str, Any]],
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        extra_body: Optional[Mapping[str, Any]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> ChatStream:
        """Stream a chat completion. The request is sent now (HTTP errors raise here); iterate the result for chunks."""
        params.pop("stream", None)
        body = _base.chat_body(model, messages, provider, {**params, "stream": True}, extra_body)
        r = self._client._stream("POST", "/chat/completions", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        return ChatStream(r, self._client)


class Chat(_Resource):
    def __init__(self, client: Anyroute) -> None:
        super().__init__(client)
        self.completions = Completions(client)


class EmbeddingsResource(_Resource):
    def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[str], Sequence[int], Sequence[Sequence[int]]],
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> Embeddings:
        """``POST /api/v1/embeddings`` (OpenAI shape, plus ``receipt``)."""
        body = drop_none({"model": model, "input": input, "provider": provider, **params})
        r = self._client._request("POST", "/embeddings", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        data = _base.json_body(r)
        return Embeddings(data, meta=AnyrouteMeta.from_response(r.headers, data))


class RerankResource(_Resource):
    def create(
        self,
        *,
        model: str,
        query: str,
        documents: Sequence[Union[str, Mapping[str, Any]]],
        top_n: Optional[int] = None,
        return_documents: Optional[bool] = None,
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> Rerank:
        """``POST /api/v1/rerank``: score ``documents`` against ``query``; ``results`` come sorted by relevance."""
        body = drop_none({"model": model, "query": query, "documents": list(documents), "top_n": top_n, "return_documents": return_documents, "provider": provider, **params})
        r = self._client._request("POST", "/rerank", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        data = _base.json_body(r)
        return Rerank(data, meta=AnyrouteMeta.from_response(r.headers, data))


class Batches(_Resource):
    """OpenAI compatible batches at half price. Requests go inline (there is no files endpoint)."""

    def create(
        self,
        requests: Optional[Sequence[Mapping[str, Any]]] = None,
        *,
        input_jsonl: Optional[str] = None,
        endpoint: Optional[str] = None,
        completion_window: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Batch:
        """Each request is ``{custom_id, body}`` (``method`` defaults to POST, ``url`` to ``endpoint`` or
        ``/v1/chat/completions``). A lane or disclosure is merged into every body's ``provider``."""
        from .lanes import check_disclosure, check_lane, stricter_disclosure, stricter_lane

        eff_lane = stricter_lane(self._client.lane, check_lane(lane))
        eff_disc = stricter_disclosure(self._client.disclosure, check_disclosure(disclosure))
        body = _base.batch_body(requests, input_jsonl, endpoint, completion_window, metadata, eff_lane, eff_disc)
        r = self._client._request("POST", "/batches", json_body=body, lane=lane, disclosure=disclosure, extra_headers=extra_headers)
        return _base.unwrap(r, Batch)

    def retrieve(self, batch_id: str) -> Batch:
        return _base.unwrap(self._client._request("GET", f"/batches/{seg(batch_id)}"), Batch)

    def list(self, *, limit: Optional[int] = None, after: Optional[str] = None) -> DataList:
        """One page: a list of batches with ``has_more``, ``first_id`` and ``last_id`` attributes."""
        return _base.unwrap(self._client._request("GET", "/batches", params={"limit": limit, "after": after}), Batch)

    def cancel(self, batch_id: str) -> Batch:
        return _base.unwrap(self._client._request("POST", f"/batches/{seg(batch_id)}/cancel"), Batch)

    def output(self, batch_id: str) -> list[dict[str, Any]]:
        """The answers as parsed JSONL lines."""
        return _base.parse_jsonl(self._client._request("GET", f"/batches/{seg(batch_id)}/output", accept="application/x-ndjson, application/jsonl, */*").text)

    def errors(self, batch_id: str) -> list[dict[str, Any]]:
        """The failed requests as parsed JSONL lines."""
        return _base.parse_jsonl(self._client._request("GET", f"/batches/{seg(batch_id)}/errors", accept="application/x-ndjson, application/jsonl, */*").text)

    def wait(self, batch_id: str, *, poll_interval: float = 5.0, timeout: Optional[float] = None) -> Batch:
        """Poll until the batch is completed, failed, expired or cancelled. Raises ``TimeoutError`` after ``timeout``
        seconds (None waits forever)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            batch = self.retrieve(batch_id)
            if batch.is_terminal:
                return batch
            if deadline is not None and time.monotonic() + poll_interval > deadline:
                raise TimeoutError(f"batch {batch_id} is still {batch.get('status')} after {timeout}s")
            time.sleep(poll_interval)

    def results(self, batch_id: str) -> BatchResults:
        """Both JSONL files of a batch, parsed. A missing errors file counts as no errors."""
        output = self.output(batch_id)
        try:
            errors = self.errors(batch_id)
        except NotFoundError:
            errors = []
        return BatchResults(batch_id, output, errors)


class Presets(_Resource):
    """Named, versioned routing configs. Use one as ``model="@preset/<name>"`` (or ``@preset/<name>@<version>``)."""

    def list(self) -> DataList:
        return _base.unwrap(self._client._request("GET", "/presets"))

    def get(self, name: str, *, version: Union[int, str, None] = None) -> APIResponse:
        return _base.unwrap(self._client._request("GET", f"/presets/{seg(name)}", params={"version": version}))

    def put(
        self,
        name: str,
        *,
        models: Sequence[str],
        description: Optional[str] = None,
        provider: Optional[Mapping[str, Any]] = None,
        params: Optional[Mapping[str, Any]] = None,
        system_prompt: Optional[str] = None,
        response_format: Optional[Mapping[str, Any]] = None,
        tools: Optional[Sequence[Mapping[str, Any]]] = None,
        tool_choice: Any = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> APIResponse:
        """Create or update (a change that alters the config makes a new version; ``changed`` says whether it did)."""
        body = _base.preset_body(models=list(models), description=description, provider=provider, params=params, system_prompt=system_prompt, response_format=response_format, tools=tools, tool_choice=tool_choice, extra=extra)
        return _base.unwrap(self._client._request("PUT", f"/presets/{seg(name)}", json_body=body))

    upsert = put

    def delete(self, name: str) -> APIResponse:
        return _base.unwrap(self._client._request("DELETE", f"/presets/{seg(name)}"))

    def versions(self, name: str) -> DataList:
        return _base.unwrap(self._client._request("GET", f"/presets/{seg(name)}/versions"))

    def diff(self, name: str, *, from_: Union[int, str, None] = None, to: Union[int, str, None] = None) -> APIResponse:
        return _base.unwrap(self._client._request("GET", f"/presets/{seg(name)}/diff", params={"from": from_, "to": to}))

    def rollback(self, name: str, version: Union[int, str]) -> APIResponse:
        return _base.unwrap(self._client._request("POST", f"/presets/{seg(name)}/rollback", json_body={"version": version}))


class Models(_Resource):
    def list(self, *, lane: Optional[str] = None, output_modalities: Union[str, Sequence[str], None] = None) -> DataList:
        """Every model, or only those that can serve ``lane`` (checked with ``Model.supports_lane``)."""
        r = self._client._request("GET", "/models", params={"output_modalities": _base.modalities_param(output_modalities)})
        return _base.filter_models(_base.unwrap(r, Model), lane)

    def retrieve(self, model_id: str) -> Model:
        for m in self.list():
            if m.get("id") == model_id:
                return m
        raise NotFoundError(f"model {model_id} is not listed", status=404, type="model_not_found")


class Receipts(_Resource):
    def get(self, receipt_id: str) -> APIResponse:
        """``GET /api/v1/receipts/{id}``: the stored receipt (v1 fields and, for newer ones, ``v2``)."""
        return _base.unwrap(self._client._request("GET", f"/receipts/{seg(receipt_id)}"))

    def proof(self, receipt_id: str) -> APIResponse:
        """``GET /api/v1/receipts/{id}/proof``: the Merkle inclusion proof once the hourly root is built."""
        return _base.unwrap(self._client._request("GET", f"/receipts/{seg(receipt_id)}/proof"))

    def keys(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        """The router's published Ed25519 receipt keys (cached for an hour)."""
        cache = self._client._keys
        if not refresh and (keys := cache.fresh()) is not None:
            return keys
        r = self._client._request("GET", _base.RECEIPT_KEYS_PATH, root=True)
        return cache.store(_base.json_body(r))

    def verify(
        self,
        receipt: Union[Mapping[str, Any], bytes, str],
        *,
        keys: Keys = None,
        public_key_hex: Optional[str] = None,
        chunks: Optional[Sequence[str]] = None,
        proof: Optional[Mapping[str, Any]] = None,
        request_sha256: Optional[str] = None,
        response_sha256: Optional[str] = None,
        raise_on_invalid: bool = False,
    ) -> ReceiptVerification:
        """Verify v1 and/or v2 (whatever the receipt carries) against the published keys, fetched and cached.
        If the receipt names a key the cache lacks, the keys are fetched again once."""
        if keys is None and public_key_hex is None:
            keys = self.keys()
            wanted = _base.receipt_key_ids(receipt)
            if wanted - {k.get("kid") for k in keys}:
                keys = self.keys(refresh=True)
        result = verify_receipt(receipt, keys, public_key_hex=public_key_hex, chunks=chunks, proof=proof, request_sha256=request_sha256, response_sha256=response_sha256)
        return result.raise_if_invalid() if raise_on_invalid else result

    def verify_id(self, receipt_id: str, *, with_proof: bool = True, raise_on_invalid: bool = False) -> ReceiptVerification:
        """Fetch a stored receipt (and its inclusion proof, when there is one) and verify both."""
        receipt = self.get(receipt_id)
        proof = None
        if with_proof:
            try:
                proof = self.proof(receipt_id)
            except NotFoundError:
                proof = None
        return self.verify(receipt, proof=proof, raise_on_invalid=raise_on_invalid)
