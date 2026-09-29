import { describe, expect, test } from "bun:test";
import { SseScanner } from "../src/sse.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("SSE scanner", () => {
  test("finds usage, chunk count and the terminator across arbitrary chunk boundaries", () => {
    const stream =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
      "data: [DONE]\n\n";
    for (const size of [1, 3, 7, 1000]) {
      const s = new SseScanner();
      const bytes = enc(stream);
      for (let i = 0; i < bytes.length; i += size) s.feed(bytes.subarray(i, i + size));
      expect(s.done).toBe(true);
      expect(s.chunks).toBe(2);
      expect(s.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      expect(s.endsOnBoundary).toBe(true);
    }
  });

  test("handles CRLF framing and multi-byte characters split across chunks", () => {
    const s = new SseScanner();
    const bytes = enc('data: {"choices":[{"delta":{"content":"héllo"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (let i = 0; i < bytes.length; i += 2) s.feed(bytes.subarray(i, i + 2));
    expect(s.done).toBe(true);
    expect(s.chunks).toBe(1);
    expect(s.endsOnBoundary).toBe(true);
  });

  test("a truncated stream is not done and does not end on a boundary", () => {
    const s = new SseScanner();
    s.feed(enc('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choi'));
    expect(s.done).toBe(false);
    expect(s.endsOnBoundary).toBe(false);
    expect(s.chunks).toBe(1);
  });

  test("notices error events and ignores comments and non-JSON data", () => {
    const s = new SseScanner();
    s.feed(enc(': keepalive\n\ndata: not json\n\ndata: {"error":{"message":"x"}}\n\n'));
    expect(s.sawError).toBe(true);
    expect(s.done).toBe(false);
  });
});
