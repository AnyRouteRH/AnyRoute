import { buildRequest } from "./harness.js";

// C130: generate text in memory only. No storage, requests or browser credential reads.
export const COPY_CODE_LANGUAGES = ["curl", "typescript", "python"];
const shellString = (value) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const pythonValue = (value, depth = 0) => {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value !== "object") return JSON.stringify(value);
  const pad = "  ".repeat(depth + 1), end = "  ".repeat(depth);
  const entries = Array.isArray(value)
    ? value.map((item) => pythonValue(item, depth + 1))
    : Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonValue(item, depth + 1)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return entries.length ? `${open}\n${pad}${entries.join(`,\n${pad}`)}\n${end}${close}` : open + close;
};

/** Export an existing wire request; credentials and one-time approvals are never replayed. */
export function codeSamples({ body, headers = {}, baseUrl = "https://anyroute.tech", apiKey = "", images = 0, files = 0 }) {
  const redact = (value) => apiKey ? value.split(apiKey).join("[key removed]") : value;
  const clean = (value) => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.filter((part) => {
      if (part?.type === "image_url" || part?.type === "input_image") { images++; return false; }
      if (part?.type === "file" || part?.type === "input_file") { files++; return false; }
      return true;
    }).map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), clean(item)]));
    return value;
  };
  const payload = clean({ ...body, stream: true });
  const extraHeaders = Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    /^[\w-]+$/.test(name) && !/authorization|cookie|(?:^|[-_])(?:key|token|secret|credential)(?:$|[-_])|^x-agent-approval$/i.test(name)
    && !/^(content-type|x-title|http-referer)$/i.test(name) && typeof value === "string" && !/[\r\n]/.test(value) // the site's own app attribution stays out of your code
  ).map(([name, value]) => [name, redact(value)]));
  const url = new URL(baseUrl);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Choose a public API base without credentials or query parameters.");
  const endpoint = redact(url.href.replace(/\/+$/, "") + "/api/v1/chat/completions");
  const notes = [];
  if (images) notes.push(`${images} image${images === 1 ? "" : "s"} omitted. Add image links before sending to include them.`);
  if (files) notes.push(`${files} file${files === 1 ? "" : "s"} omitted. Add file contents before sending to include them.`);
  const comments = (prefix) => notes.length ? notes.map((note) => `${prefix} ${note}\n`).join("") : "";
  const json = JSON.stringify(payload, null, 2);
  const curlHeaders = Object.entries(extraHeaders).map(([name, value]) => `  -H ${shellString(`${name}: ${value}`)} \\\n`).join("");
  const tsHeaders = Object.entries(extraHeaders).map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},\n`).join("");
  const pyHeaders = Object.entries(extraHeaders).map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},\n`).join("");
  return {
    notes,
    curl: `${comments("#")}curl --fail-with-body --no-buffer ${shellString(endpoint)} \\\n  -H "Authorization: Bearer $ANYROUTE_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n${curlHeaders}  --data-raw ${shellString(json)}`,
    typescript: `${comments("//")}const apiKey = process.env.ANYROUTE_API_KEY;\nif (!apiKey) throw new Error("Set ANYROUTE_API_KEY before running.");\n\nconst response = await fetch(${JSON.stringify(endpoint)}, {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer " + apiKey,\n    "Content-Type": "application/json",\n${tsHeaders}  },\n  body: JSON.stringify(${json}),\n});\nif (!response.ok) throw new Error(await response.text());\nconsole.log(await response.text());`,
    python: `${comments("#")}import os\nimport requests\n\nresponse = requests.post(\n  ${JSON.stringify(endpoint)},\n  headers={\n    "Authorization": "Bearer " + os.environ["ANYROUTE_API_KEY"],\n    "Content-Type": "application/json",\n${pyHeaders}  },\n  json=${pythonValue(payload)},\n  timeout=120,\n)\nresponse.raise_for_status()\nprint(response.text)`,
  };
}

/** Use Chat's existing capability gating, message conversion and tool handling. */
export function copyAsCode({ model, settings, system, messages = [], ...options }) {
  let images = 0, files = 0;
  const textMessages = messages.map((message) => {
    images += (message.images || []).length;
    const attachments = (message.attachments || []).filter((attachment) => {
      if (attachment.kind === "image") { images++; return false; }
      if (attachment.kind === "file") { files++; return false; }
      return true;
    });
    return { ...message, attachments };
  });
  const { body, notes, error } = buildRequest({ model, settings, system, messages: textMessages });
  if (error) return { error };
  const samples = codeSamples({ ...options, body, images, files });
  return { ...samples, notes: [...notes, ...samples.notes], error: "" };
}
