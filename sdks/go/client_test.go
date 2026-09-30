package anyroute

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorded is what the fake router saw.
type recorded struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   map[string]any
}

type fakeRouter struct {
	t      *testing.T
	mu     sync.Mutex
	calls  []recorded
	routes map[string]http.HandlerFunc
}

func newFake(t *testing.T) (*fakeRouter, *Client) {
	f := &fakeRouter{t: t, routes: map[string]http.HandlerFunc{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rec := recorded{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone()}
		if len(b) > 0 {
			_ = json.Unmarshal(b, &rec.Body)
		}
		f.mu.Lock()
		f.calls = append(f.calls, rec)
		h := f.routes[r.Method+" "+r.URL.Path]
		f.mu.Unlock()
		if h == nil {
			w.WriteHeader(404)
			fmt.Fprintf(w, `{"error":{"code":404,"message":"no route %s","type":"not_found"}}`, r.URL.Path)
			return
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return f, NewClient(WithAPIKey("sk-test"), WithBaseURL(srv.URL+"/api/v1/"), WithHTTPClient(srv.Client()))
}

func (f *fakeRouter) on(route string, h http.HandlerFunc) { f.routes[route] = h }

func (f *fakeRouter) last() recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func jsonReply(v string, headers ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, v)
	}
}

func TestChat(t *testing.T) {
	f, c := newFake(t)
	r := signV1(t, v1Payload)
	rb, _ := json.Marshal(r)
	f.on("POST /api/v1/chat/completions", jsonReply(`{"id":"gen-1","object":"chat.completion","created":1790000000,"model":"example/model",
		"choices":[{"index":0,"message":{"role":"assistant","content":"Hello"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"cost":0.00001},"receipt":`+string(rb)+`}`,
		"X-Generation-Id", "gen-1", "X-Receipt-Id", "gen-1", "X-Anyroute-Lane", "public", "X-Anyroute-Disclosure", "vendor-forwarded", "X-Anyroute-Policy-Hash", "sha256:abc"))

	temp := 0.2
	res, err := c.Chat(context.Background(), ChatRequest{Model: "example/model", Messages: []Message{UserMessage("Hi <there>")}, Temperature: &temp, Extra: map[string]any{"transforms": []string{"middle-out"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Text() != "Hello" || res.Usage.TotalTokens != 4 || *res.Usage.Cost != 0.00001 {
		t.Fatalf("response: %+v", res)
	}
	if res.Meta.GenerationID != "gen-1" || res.Meta.ReceiptID != "gen-1" || res.Meta.Lane != "public" || res.Meta.Disclosure != "vendor-forwarded" || res.Meta.PolicyHash != "sha256:abc" {
		t.Fatalf("meta: %+v", res.Meta)
	}
	if res.Receipt == nil || res.Receipt.KeyID != testKid {
		t.Fatalf("receipt: %+v", res.Receipt)
	}
	if v := VerifyReceiptV1(res.Receipt, VerifyOptions{Keys: testKeySet(t)}); !v.Valid {
		t.Fatalf("inline receipt: %+v", v.Checks)
	}
	got := f.last()
	if got.Header.Get("Authorization") != "Bearer sk-test" || got.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("headers: %v", got.Header)
	}
	if got.Body["model"] != "example/model" || got.Body["temperature"] != 0.2 || got.Body["transforms"] == nil {
		t.Fatalf("body: %v", got.Body)
	}
	if _, has := got.Body["stream"]; has {
		t.Fatal("stream should be omitted")
	}
	if _, err := c.Chat(context.Background(), ChatRequest{Model: "m", Stream: true}); !errors.Is(err, ErrStreamRequired) {
		t.Fatalf("stream on Chat: %v", err)
	}
}

func TestClientVerifyReceiptFetchesKeys(t *testing.T) {
	f, c := newFake(t)
	ks, _ := json.Marshal(testKeySet(t))
	f.on("GET "+ReceiptKeysPath, jsonReply(string(ks)))
	v, err := c.VerifyReceipt(context.Background(), signV1(t, v1Payload))
	if err != nil || !v.Valid {
		t.Fatalf("%v %+v", err, v)
	}
}

// sseStream writes the fixture's three events, each followed by its chain comment, then the receipt and [DONE].
func sseStream(t *testing.T, fx v2Fixture, mutate func(i int, data string) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Generation-Id", fx.Claims.RID)
		fl := w.(http.Flusher)
		io.WriteString(w, ": keep-alive\n\n")
		for i, d := range fx.Chunks {
			if mutate != nil {
				d = mutate(i, d)
			}
			fmt.Fprintf(w, "data: %s\n\n: anyroute-chain %d %s\n\n", d, i+1, fx.ChainSteps[i])
			fl.Flush()
		}
		claims, _ := json.Marshal(fx.Claims)
		fmt.Fprintf(w, "data: {\"receipt\":{\"id\":%q,\"payload\":{\"v\":1},\"sig\":\"AA==\",\"key_id\":%q,\"alg\":\"Ed25519\",\"v2\":{\"alg\":\"EdDSA\",\"kid\":%q,\"content_type\":\"application/cose\",\"cose\":%q,\"claims\":%s,\"leaf\":%q}}}\n\n",
			fx.Claims.RID, fx.KeyID, fx.KeyID, fx.COSE, claims, fx.Leaf)
		io.WriteString(w, "data: [DONE]\n\n")
	}
}

func TestChatStream(t *testing.T) {
	f, c := newFake(t)
	fx := loadV2Fixture(t)
	f.on("POST /api/v1/chat/completions", sseStream(t, fx, nil))

	s, err := c.ChatStream(context.Background(), ChatRequest{Model: "example/model", Messages: []Message{UserMessage("Hi")}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var text strings.Builder
	n := 0
	finish := ""
	for s.Next() {
		n++
		ch := s.Chunk()
		text.WriteString(ch.Choices[0].Delta.Content)
		if ch.Choices[0].FinishReason != "" {
			finish = ch.Choices[0].FinishReason
		}
	}
	if err := s.Err(); err != nil {
		t.Fatal(err)
	}
	if n != 3 || text.String() != "Hello" || finish != "stop" {
		t.Fatalf("chunks %d text %q finish %q", n, text.String(), finish)
	}
	if got := f.last(); got.Body["stream"] != true || got.Header.Get("Accept") != "text/event-stream" {
		t.Fatalf("request: %v %v", got.Body, got.Header)
	}
	if s.Meta.GenerationID != fx.Claims.RID {
		t.Fatalf("meta: %+v", s.Meta)
	}
	rc := s.Receipt()
	if rc == nil || rc.V2 == nil {
		t.Fatal("no receipt")
	}
	chain := s.VerifyChain()
	if !chain.OK || chain.Head != fx.Claims.Resp.Chain || chain.SignedHead != chain.Head || chain.FirstMismatch != 0 {
		t.Fatalf("chain: %+v", chain)
	}
	for i, e := range s.Events() {
		if e.Chain != fx.ChainSteps[i] {
			t.Fatalf("event %d chain %s", i+1, e.Chain)
		}
	}
	v := VerifyReceiptV2(rc.V2.COSE, VerifyV2Options{PublicKeyHex: testPubHex, Chunks: s.Chunks()})
	if !v.Valid {
		t.Fatalf("receipt v2: %+v", v.Checks)
	}
}

func TestChatStreamAlteredFailsChain(t *testing.T) {
	f, c := newFake(t)
	fx := loadV2Fixture(t)
	f.on("POST /api/v1/chat/completions", sseStream(t, fx, func(i int, d string) string {
		if i == 1 {
			return strings.Replace(d, `"lo"`, `"LO"`, 1)
		}
		return d
	}))
	s, err := c.ChatStream(context.Background(), ChatRequest{Model: "example/model", Messages: []Message{UserMessage("Hi")}})
	if err != nil {
		t.Fatal(err)
	}
	for s.Next() {
	}
	r := s.VerifyChain()
	if r.OK || r.FirstMismatch != 2 {
		t.Fatalf("altered stream: %+v", r)
	}
	if v := VerifyReceiptV2(s.Receipt().V2.COSE, VerifyV2Options{PublicKeyHex: testPubHex, Chunks: s.Chunks()}); v.Valid {
		t.Fatal("receipt accepted over altered events")
	}
}

func TestChatStreamHTTPError(t *testing.T) {
	f, c := newFake(t)
	f.on("POST /api/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		io.WriteString(w, `{"error":{"code":404,"message":"Model x/y does not exist","type":"model_not_found","metadata":{"model":"x/y"}}}`)
	})
	_, err := c.ChatStream(context.Background(), ChatRequest{Model: "x/y"})
	var e *APIError
	if !errors.As(err, &e) || e.StatusCode != 404 || e.Type != "model_not_found" || e.Metadata["model"] != "x/y" {
		t.Fatalf("err: %#v", err)
	}
}

func TestRateLimited(t *testing.T) {
	f, c := newFake(t)
	f.on("POST /api/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "12")
		w.WriteHeader(429)
		io.WriteString(w, `{"error":{"code":429,"message":"Slow down","type":"rate_limited","metadata":{"limit":"rpm"}}}`)
	})
	_, err := c.Chat(context.Background(), ChatRequest{Model: "m", Messages: []Message{UserMessage("x")}})
	if !IsRateLimited(err) {
		t.Fatalf("IsRateLimited(%v) = false", err)
	}
	var e *APIError
	errors.As(err, &e)
	if e.StatusCode != 429 || e.Code != 429 || e.Type != "rate_limited" || e.Message != "Slow down" || e.RetryAfter != 12*time.Second || e.Metadata["limit"] != "rpm" {
		t.Fatalf("%+v", e)
	}
	if d, ok := RetryAfter(err); !ok || d != 12*time.Second {
		t.Fatalf("RetryAfter = %v %v", d, ok)
	}
	if !strings.Contains(err.Error(), "429 rate_limited: Slow down") {
		t.Fatalf("message: %s", err)
	}
	if IsRateLimited(errors.New("other")) {
		t.Fatal("plain error counted as rate limited")
	}
}

func TestEmbeddings(t *testing.T) {
	f, c := newFake(t)
	f.on("POST /api/v1/embeddings", jsonReply(`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,-0.2,0.3]},{"object":"embedding","index":1,"embedding":"AACAPwAAAEA="}],"model":"example/embed","usage":{"prompt_tokens":4,"total_tokens":4}}`, "X-Generation-Id", "gen-e"))
	res, err := c.Embeddings(context.Background(), EmbeddingsRequest{Model: "example/embed", Input: []string{"a", "b"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Data) != 2 || res.Data[0].Embedding[1] != -0.2 || res.Data[1].Embedding[0] != 1 || res.Data[1].Embedding[1] != 2 {
		t.Fatalf("%+v", res.Data)
	}
	if res.Meta.GenerationID != "gen-e" || res.Usage.PromptTokens != 4 {
		t.Fatalf("%+v", res)
	}
	if in, _ := f.last().Body["input"].([]any); len(in) != 2 {
		t.Fatalf("body %v", f.last().Body)
	}
}

func TestRerank(t *testing.T) {
	f, c := newFake(t)
	f.on("POST /api/v1/rerank", jsonReply(`{"id":"gen-r","model":"example/rerank","results":[{"index":1,"relevance_score":0.93,"document":{"text":"Paris is in France"}},{"index":0,"relevance_score":0.12,"document":"Berlin"}],"usage":{"total_tokens":20,"search_units":1,"cost":0.00002},"cost":0.00002}`))
	top := 2
	yes := true
	res, err := c.Rerank(context.Background(), RerankRequest{Model: "example/rerank", Query: "capital of France", Documents: []any{"Berlin", RerankDocument{Text: "Paris is in France"}}, TopN: &top, ReturnDocuments: &yes})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Results) != 2 || res.Results[0].Index != 1 || res.Results[0].Document.Text != "Paris is in France" || res.Results[1].Document.Text != "Berlin" || res.Usage.SearchUnits != 1 {
		t.Fatalf("%+v", res)
	}
	body := f.last().Body
	docs := body["documents"].([]any)
	if docs[0] != "Berlin" || docs[1].(map[string]any)["text"] != "Paris is in France" || body["top_n"] != float64(2) {
		t.Fatalf("body %v", body)
	}
}

func TestLaneHeadersAndBodyMerge(t *testing.T) {
	f, c := newFake(t)
	f.on("POST /api/v1/chat/completions", jsonReply(`{"id":"g","choices":[]}`))
	ctx := context.Background()
	msg := []Message{UserMessage("x")}

	// Request lane on a body without provider: header and body both set.
	if _, err := c.Chat(ctx, ChatRequest{Model: "m", Messages: msg}, WithRequestLane(LaneAttested), WithRequestDisclosure(DisclosurePolicy)); err != nil {
		t.Fatal(err)
	}
	got := f.last()
	p := got.Body["provider"].(map[string]any)
	if got.Header.Get("X-Anyroute-Lane") != "attested" || got.Header.Get("X-Anyroute-Disclosure-Max") != "policy" || p["lane"] != "attested" || p["disclosure"] != "policy" {
		t.Fatalf("headers %v body %v", got.Header, p)
	}

	// A stricter lane already in the body is kept; other provider fields survive.
	no := false
	_, err := c.Chat(ctx, ChatRequest{Model: "m", Messages: msg, Provider: &ProviderPreferences{Lane: LaneUnlinkable, Disclosure: DisclosureNone, Only: []string{"relay"}, AllowFallbacks: &no}}, WithRequestLane(LanePublic), WithRequestDisclosure(DisclosureAny))
	if err != nil {
		t.Fatal(err)
	}
	got = f.last()
	p = got.Body["provider"].(map[string]any)
	if p["lane"] != "unlinkable" || p["disclosure"] != "none" || p["allow_fallbacks"] != false || p["only"].([]any)[0] != "relay" {
		t.Fatalf("body %v", p)
	}
	if got.Header.Get("X-Anyroute-Lane") != "unlinkable" || got.Header.Get("X-Anyroute-Disclosure-Max") != "none" {
		t.Fatalf("headers %v", got.Header)
	}

	// A looser lane in the body is raised to the requested one.
	if _, err := c.Chat(ctx, ChatRequest{Model: "m", Messages: msg, Provider: &ProviderPreferences{Lane: LanePublic}}, WithRequestLane(LaneAttested)); err != nil {
		t.Fatal(err)
	}
	if p := f.last().Body["provider"].(map[string]any); p["lane"] != "attested" {
		t.Fatalf("body %v", p)
	}

	// Client default applies when no request option is given; no lane means no header and no provider object.
	cl := NewClient(WithBaseURL(c.BaseURL()), WithLane(LaneAttested), WithHeader("X-Title", "tests"), WithAPIKey("k"))
	if _, err := cl.Chat(ctx, ChatRequest{Model: "m", Messages: msg}); err != nil {
		t.Fatal(err)
	}
	got = f.last()
	if got.Header.Get("X-Anyroute-Lane") != "attested" || got.Header.Get("X-Title") != "tests" {
		t.Fatalf("headers %v", got.Header)
	}
	if _, err := c.Chat(ctx, ChatRequest{Model: "m", Messages: msg}); err != nil {
		t.Fatal(err)
	}
	got = f.last()
	if _, has := got.Body["provider"]; has || got.Header.Get("X-Anyroute-Lane") != "" {
		t.Fatalf("unexpected routing: %v %v", got.Body, got.Header)
	}
}

func TestModelsLaneFilter(t *testing.T) {
	f, c := newFake(t)
	f.on("GET /api/v1/models", jsonReply(`{"data":[
		{"id":"a/public-only","name":"A","architecture":{"output_modalities":["text"]},"lanes":["public"],"attested_available":false,"attestation":null},
		{"id":"b/attested","name":"B","architecture":{"output_modalities":["text"]},"lanes":["public","attested"],"attested_available":true,
		 "attestation":{"best":"attested","manifest_ref":null,"exec_profile_id":null,"policy_hash":"sha256:p"},
		 "disclosure":{"best":"attested","endpoints":{"attested":1,"policy":0,"vendor-forwarded":2}},"routing_variants":["nitro","floor","private"]},
		{"id":"c/rerank","name":"C","architecture":{"output_modalities":["rerank"]},"lanes":["public"]}]}`))
	ctx := context.Background()
	all, err := c.Models(ctx, ModelsQuery{})
	if err != nil || len(all) != 3 {
		t.Fatalf("%v %d", err, len(all))
	}
	att, err := c.Models(ctx, ModelsQuery{Lane: LaneAttested})
	if err != nil {
		t.Fatal(err)
	}
	if len(att) != 1 || att[0].ID != "b/attested" || !att[0].SupportsLane(LaneAttested) || att[0].SupportsLane(LaneUnlinkable) {
		t.Fatalf("%+v", att)
	}
	if *att[0].Attestation.PolicyHash != "sha256:p" || att[0].Disclosure.Endpoints["vendor-forwarded"] != 2 || len(att[0].Raw) == 0 {
		t.Fatalf("%+v", att[0])
	}
	if q := f.last().Query; q != "lane=attested" {
		t.Fatalf("query %q", q)
	}
	rr, err := c.Models(ctx, ModelsQuery{OutputModalities: []string{"rerank"}})
	if err != nil || len(rr) != 1 || rr[0].ID != "c/rerank" {
		t.Fatalf("%v %+v", err, rr)
	}
	if !all[0].SupportsLane(LanePublic) {
		t.Fatal("public lane")
	}
}

func TestBatches(t *testing.T) {
	f, c := newFake(t)
	var polls int
	var mu sync.Mutex
	batch := func(status string, done int) string {
		return fmt.Sprintf(`{"id":"batch_1","object":"batch","endpoint":"/v1/chat/completions","status":%q,"output_url":"/api/v1/batches/batch_1/output","errors_url":"/api/v1/batches/batch_1/errors","created_at":1790000000,"in_progress_at":null,"expires_at":1790086400,"completed_at":null,"request_counts":{"total":2,"completed":%d,"failed":0},"cost":{"usd":0.0005,"list_usd":0.001,"discount_bps":5000},"results_expire_at":null,"metadata":null}`, status, done)
	}
	f.on("POST /api/v1/batches", jsonReply(batch("validating", 0)))
	f.on("GET /api/v1/batches/batch_1", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		polls++
		n := polls
		mu.Unlock()
		switch {
		case n < 2:
			io.WriteString(w, batch("in_progress", 1))
		default:
			io.WriteString(w, batch("completed", 2))
		}
	})
	f.on("GET /api/v1/batches", jsonReply(`{"object":"list","data":[`+batch("completed", 2)+`],"first_id":"batch_1","last_id":"batch_1","has_more":false}`))
	f.on("POST /api/v1/batches/batch_1/cancel", jsonReply(batch("cancelling", 2)))
	f.on("GET /api/v1/batches/batch_1/output", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		io.WriteString(w, `{"id":"line_1","custom_id":"q1","response":{"status_code":200,"request_id":"gen-1","body":{"id":"gen-1","choices":[{"index":0,"message":{"role":"assistant","content":"4"},"finish_reason":"stop"}]}},"error":null}`+"\n\n")
		io.WriteString(w, `{"id":"line_2","custom_id":"q2","response":{"status_code":200,"request_id":"gen-2","body":{"id":"gen-2","choices":[{"index":0,"message":{"role":"assistant","content":"6"},"finish_reason":"stop"}]}},"error":null}`+"\n")
	})
	f.on("GET /api/v1/batches/batch_1/errors", jsonReply(`{"id":"line_3","custom_id":"q3","response":null,"error":{"code":"model_not_found","message":"no such model"}}`+"\n"))

	ctx := context.Background()
	b, err := c.CreateBatch(ctx, CreateBatchRequest{Requests: []BatchRequestItem{
		{CustomID: "q1", Method: "POST", URL: "/v1/chat/completions", Body: ChatRequest{Model: "m", Messages: []Message{UserMessage("2+2")}}},
		{CustomID: "q2", Method: "POST", URL: "/v1/chat/completions", Body: map[string]any{"model": "m", "messages": []any{map[string]any{"role": "user", "content": "3+3"}}, "provider": map[string]any{"lane": "unlinkable"}}},
	}, Metadata: map[string]string{"job": "nightly"}}, WithRequestLane(LaneAttested))
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != "batch_1" || b.Status != BatchValidating || b.Terminal() || b.Cost.DiscountBps != 5000 {
		t.Fatalf("%+v", b)
	}
	sent := f.last().Body["requests"].([]any)
	p0 := sent[0].(map[string]any)["body"].(map[string]any)["provider"].(map[string]any)
	p1 := sent[1].(map[string]any)["body"].(map[string]any)["provider"].(map[string]any)
	if p0["lane"] != "attested" || p1["lane"] != "unlinkable" {
		t.Fatalf("lane merge into batch bodies: %v %v", p0, p1)
	}
	if _, has := sent[0].(map[string]any)["body"].(map[string]any)["stream"]; has {
		t.Fatal("stream sent in a batch body")
	}

	done, err := c.WaitBatch(ctx, "batch_1", time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != BatchCompleted || !done.Terminal() || done.RequestCounts.Completed != 2 || polls != 2 {
		t.Fatalf("%+v polls=%d", done, polls)
	}

	out, err := c.BatchOutput(ctx, "batch_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[1].CustomID != "q2" || out[0].Response.StatusCode != 200 {
		t.Fatalf("%+v", out)
	}
	cr, err := out[0].ChatResponse()
	if err != nil || cr.Text() != "4" {
		t.Fatalf("%v %+v", err, cr)
	}
	errs, err := c.BatchErrors(ctx, "batch_1")
	if err != nil || len(errs) != 1 || errs[0].Error.Code != "model_not_found" || errs[0].Response != nil {
		t.Fatalf("%v %+v", err, errs)
	}

	list, err := c.ListBatches(ctx, ListBatchesParams{Limit: 10, After: "batch_0"})
	if err != nil || len(list.Data) != 1 || list.HasMore {
		t.Fatalf("%v %+v", err, list)
	}
	if q := f.last().Query; q != "after=batch_0&limit=10" {
		t.Fatalf("query %q", q)
	}
	cb, err := c.CancelBatch(ctx, "batch_1")
	if err != nil || cb.Status != BatchCancelling {
		t.Fatalf("%v %+v", err, cb)
	}

	// WaitBatch stops when the context ends.
	f.on("GET /api/v1/batches/batch_2", jsonReply(strings.Replace(batch("in_progress", 0), "batch_1", "batch_2", 1)))
	cctx, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	if _, err := c.WaitBatch(cctx, "batch_2", 5*time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait with deadline: %v", err)
	}
}

func TestReceiptEndpoints(t *testing.T) {
	f, c := newFake(t)
	r := signV1(t, v1Payload)
	rb, _ := json.Marshal(r)
	f.on("GET /api/v1/receipts/gen-1", jsonReply(`{"data":`+strings.Replace(string(rb), `"id":"gen-1"`, `"id":"gen-1","version":1`, 1)+`}`))
	f.on("GET /api/v1/receipts/gen-1/proof", jsonReply(`{"data":{"rid":"gen-1","leaf":"`+r.Leaf+`","leaf_version":1,"rooted":false,"anchored":false,"status":"pending"}}`))
	ks, _ := json.Marshal(testKeySet(t))
	f.on("GET "+ReceiptKeysPath, jsonReply(string(ks)))
	ctx := context.Background()
	got, err := c.GetReceipt(ctx, "gen-1")
	if err != nil || got.Version != 1 || got.KeyID != testKid {
		t.Fatalf("%v %+v", err, got)
	}
	proof, err := c.ReceiptProof(ctx, "gen-1")
	if err != nil || proof.Leaf != r.Leaf || proof.Rooted || proof.Status != "pending" {
		t.Fatalf("%v %+v", err, proof)
	}
	keys, err := c.ReceiptKeys(ctx, false)
	if err != nil || len(keys.Keys) != 1 || keys.Keys[0].Kid != testKid {
		t.Fatalf("%v %+v", err, keys)
	}
	if v := VerifyReceiptV1(got, VerifyOptions{Keys: keys}); !v.Valid {
		t.Fatalf("%+v", v.Checks)
	}
}

func TestNewClientDefaults(t *testing.T) {
	t.Setenv("ANYROUTE_API_KEY", "env-key")
	t.Setenv("ANYROUTE_BASE_URL", "")
	c := NewClient()
	if c.apiKey != "env-key" || c.BaseURL() != DefaultBaseURL {
		t.Fatalf("%q %q", c.apiKey, c.BaseURL())
	}
	t.Setenv("ANYROUTE_BASE_URL", "http://localhost:9/api/v1")
	if got := NewClient().BaseURL(); got != "http://localhost:9" {
		t.Fatalf("base url %q", got)
	}
}
