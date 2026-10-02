/** A bounded, dependency-free JSON Schema subset. Unknown assertions fail closed. */
export type Issue = { path: string; reason: string };
export type Check = { valid: boolean; errors: Issue[] };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const ptr = (v: string) => v.replaceAll("~", "~0").replaceAll("/", "~1");
const at = (path: string, key: string | number) => `${path}/${ptr(String(key))}`;
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "nullable", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "minProperties", "maxProperties", "$ref", "$defs", "definitions", "title", "description", "default", "$schema", "$id", "examples", "deprecated", "readOnly", "writeOnly"]);
const COUNTS = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"];
const NUMBERS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
export const MAX_OUTPUT_BYTES = 1024 * 1024;

function ref(root: unknown, name: string): unknown {
  if (!name.startsWith("#/")) return undefined;
  let node: any = root;
  for (const part of name.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!object(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** Reject unsupported or malformed schemas before spending on a provider call. */
export function schemaIssues(root: unknown): Issue[] {
  const errors: Issue[] = [];
  let nodes = 0;
  const seen = new Set<unknown>();
  const error = (path: string, reason: string) => { if (errors.length < 16) errors.push({ path, reason }); };
  function visit(s: unknown, path: string, depth: number) {
    if (++nodes > 4096 || depth > 64) { error(path, "schema exceeds validation limits"); return; }
    if (typeof s === "boolean") return;
    if (!object(s)) { error(path, "schema must be an object or boolean"); return; }
    if (seen.has(s)) return;
    seen.add(s);
    for (const key of Object.keys(s)) if (!KEYS.has(key)) error(at(path, key), "unsupported schema keyword");
    if (s.type !== undefined && !(typeof s.type === "string" ? TYPES.has(s.type) : Array.isArray(s.type) && s.type.length > 0 && s.type.every((t: unknown) => typeof t === "string" && TYPES.has(t)))) error(at(path, "type"), "invalid type");
    if (s.nullable !== undefined && typeof s.nullable !== "boolean") error(at(path, "nullable"), "must be boolean");
    if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((k: unknown) => typeof k === "string"))) error(at(path, "required"), "must be an array of property names");
    if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.length > 0)) error(at(path, "enum"), "must be a non-empty array");
    for (const key of COUNTS) if (s[key] !== undefined && !(Number.isSafeInteger(s[key]) && s[key] >= 0)) error(at(path, key), "must be a non-negative integer");
    for (const key of NUMBERS) if (s[key] !== undefined && !(typeof s[key] === "number" && Number.isFinite(s[key]))) error(at(path, key), "must be a finite number");
    for (const key of ["properties", "$defs", "definitions"]) if (s[key] !== undefined) {
      if (!object(s[key])) error(at(path, key), "must be an object");
      else for (const [k, value] of Object.entries(s[key])) visit(value, at(at(path, key), k), depth + 1);
    }
    for (const key of ["items", "additionalProperties"]) if (s[key] !== undefined) visit(s[key], at(path, key), depth + 1);
    if (s.anyOf !== undefined) {
      if (!Array.isArray(s.anyOf) || !s.anyOf.length) error(at(path, "anyOf"), "must be a non-empty array");
      else s.anyOf.forEach((v: unknown, i: number) => visit(v, at(at(path, "anyOf"), i), depth + 1));
    }
    if (s.$ref !== undefined) {
      const target = typeof s.$ref === "string" ? ref(root, s.$ref) : undefined;
      if (target === undefined) error(at(path, "$ref"), "only existing local #/ references are supported");
      else visit(target, s.$ref, depth + 1);
    }
  }
  visit(root, "", 0);
  return errors;
}

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  return false;
};
const matches = (value: unknown, type: string) => type === "null" ? value === null : type === "object" ? object(value) : type === "array" ? Array.isArray(value) : type === "integer" ? typeof value === "number" && Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type;

export function validateSchema(value: unknown, root: unknown): Check {
  const unsupported = schemaIssues(root);
  if (unsupported.length) return { valid: false, errors: unsupported };
  let nodes = 0;
  function visit(v: unknown, s: any, path: string, depth: number): Issue[] {
    const bad = (reason: string): Issue[] => [{ path, reason }];
    if (++nodes > 100_000 || depth > 64) return bad("output exceeds validation limits");
    if (s === true) return [];
    if (s === false) return bad("value is forbidden by schema");
    let errors: Issue[] = [];
    const add = (issues: Issue[]) => { errors = [...errors, ...issues].slice(0, 16); };
    if (s.$ref !== undefined) add(visit(v, ref(root, s.$ref), path, depth + 1));
    if (s.type !== undefined && !(v === null && s.nullable === true) && !(Array.isArray(s.type) ? s.type : [s.type]).some((t: string) => matches(v, t))) return [...errors, ...bad("type does not match schema")].slice(0, 16);
    if (s.enum && !s.enum.some((x: unknown) => equal(v, x))) add(bad("value is outside enum"));
    if (Object.hasOwn(s, "const") && !equal(v, s.const)) add(bad("value differs from const"));
    if (s.anyOf && !s.anyOf.some((x: unknown) => visit(v, x, path, depth + 1).length === 0)) add(bad("value matches no anyOf branch"));
    if (object(v)) {
      for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) add([{ path: at(path, k), reason: "required property is missing" }]);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties && Object.hasOwn(s.properties, k)) add(visit(x, s.properties[k], at(path, k), depth + 1));
        else if (s.additionalProperties === false) add([{ path: at(path, k), reason: "additional property is forbidden" }]);
        else if (object(s.additionalProperties)) add(visit(x, s.additionalProperties, at(path, k), depth + 1));
      }
      if (s.minProperties !== undefined && Object.keys(v).length < s.minProperties) add(bad("too few properties"));
      if (s.maxProperties !== undefined && Object.keys(v).length > s.maxProperties) add(bad("too many properties"));
    }
    if (Array.isArray(v)) {
      if (s.items !== undefined) v.forEach((x, i) => add(visit(x, s.items, at(path, i), depth + 1)));
      if (s.minItems !== undefined && v.length < s.minItems) add(bad("too few items"));
      if (s.maxItems !== undefined && v.length > s.maxItems) add(bad("too many items"));
    }
    if (typeof v === "string") {
      const length = Array.from(v).length;
      if (s.minLength !== undefined && length < s.minLength) add(bad("string is too short"));
      if (s.maxLength !== undefined && length > s.maxLength) add(bad("string is too long"));
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) add(bad("number is not finite"));
      if (s.minimum !== undefined && v < s.minimum) add(bad("number is below minimum"));
      if (s.maximum !== undefined && v > s.maximum) add(bad("number is above maximum"));
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) add(bad("number must exceed exclusiveMinimum"));
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) add(bad("number must be below exclusiveMaximum"));
    }
    return errors;
  }
  const errors = visit(value, root, "", 0);
  return { valid: errors.length === 0, errors };
}

export function checkText(text: unknown, format: Record<string, any>): Check {
  const invalid = (reason: string): Check => ({ valid: false, errors: [{ path: "", reason }] });
  if (typeof text !== "string") return invalid("message content is not text");
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) return invalid("output exceeds the 1 MiB validation limit");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid("message is not valid JSON"); }
  if (format.type === "json_schema") return validateSchema(value, format.json_schema.schema);
  return object(value) ? { valid: true, errors: [] } : invalid("json_object requires an object");
}
