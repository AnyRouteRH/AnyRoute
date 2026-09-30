// The rules that decide which columns need an explicit review in the inventory. They look at a column's NAME and TYPE only:
// a name that suggests request content or a network address, or a type that can hold free-form content, is flagged, and the
// inventory must then carry a reviewed justification that lists exactly those flags (see inventory.ts, the tests in
// test/data-inventory.test.ts and the privacy check in test/api.test.ts). Adding a column that trips a rule therefore fails
// the build until someone writes down why it is safe, or removes the column.

export type TypeFamily = "text" | "json" | "binary" | "network" | "array" | "integer" | "number" | "boolean" | "time" | "other";

/** The family of a SQL type, from drizzle's getSQLType() ("text[]", "numeric(78, 0)") or information_schema ("text[]" via informationSchemaType). */
export function typeFamily(sqlType: string): TypeFamily {
  const t = sqlType.trim().toLowerCase();
  if (t.endsWith("[]") || t === "array") return "array";
  if (t === "json" || t === "jsonb") return "json";
  if (/^(text|varchar|character varying|character|char|citext|name|bpchar)(\(|$)/.test(t)) return "text";
  if (t === "bytea") return "binary";
  if (/^(inet|cidr|macaddr8?)$/.test(t)) return "network";
  if (/^(smallint|integer|int|int2|int4|int8|bigint|serial|bigserial|smallserial)$/.test(t)) return "integer";
  if (/^(numeric|decimal|real|float4|float8|double precision)(\(|$)/.test(t)) return "number";
  if (/^(boolean|bool)$/.test(t)) return "boolean";
  if (/^(timestamp|timestamptz|date|time|interval)/.test(t)) return "time";
  return "other";
}

/** The SQL type a caller reads from information_schema.columns (data_type, udt_name), in the vocabulary typeFamily() reads. */
export const informationSchemaType = (dataType: string, udtName: string) => (dataType === "ARRAY" ? `${udtName.replace(/^_/, "")}[]` : dataType);

/** Types that can carry a sentence. Numbers, flags and timestamps cannot, so a name like `price_prompt` on a bigint is a price. */
const holdsText = (f: TypeFamily) => f === "text" || f === "json" || f === "binary" || f === "array" || f === "other";

/** Words that suggest the text of a request or an answer. Matched as whole words between underscores. */
export const CONTENT_WORDS = [
  "prompt", "prompts", "content", "contents", "message", "messages", "completion", "completions", "output", "outputs", "response", "responses", "input", "inputs",
  "answer", "answers", "text", "body", "question", "query", "reply", "transcript", "conversation", "chat", "instruction", "instructions", "system", "document", "documents", "utterance", "payload",
  "request", "requests", "note", "notes", "comment", "comments", "description", "title", "error", "errors",
] as const;

/** Words that suggest a caller's network address, or something that identifies a caller's device or origin. */
export const NETWORK_WORDS = [
  "ip", "ips", "ipv4", "ipv6", "address", "addr", "host", "hostname", "remote", "origin", "user_agent", "useragent", "ua", "referer", "referrer", "forwarded", "xff", "geo", "country", "city",
  "latitude", "longitude", "cookie", "header", "headers", "fingerprint", "device", "mac", "url", "uri", "domain", "endpoint", "email", "phone", "contact",
] as const;

const wordRe = (words: readonly string[]) => new RegExp(`(^|_)(${words.join("|")})($|_)`);
const CONTENT_RE = wordRe(CONTENT_WORDS);
const NETWORK_RE = wordRe(NETWORK_WORDS);

/** The flags a column raises, sorted. An empty list means no explicit review is needed. */
export function columnFlags(name: string, sqlType: string): string[] {
  const family = typeFamily(sqlType);
  const flags: string[] = [];
  if (CONTENT_RE.test(name) && holdsText(family)) flags.push("name:content");
  if (NETWORK_RE.test(name)) flags.push("name:network");
  if (family === "json") flags.push("type:json");
  if (family === "network") flags.push("type:network");
  if (family === "binary") flags.push("type:binary");
  return flags.sort();
}
