import { describe, expect, test } from "bun:test";
import { checkText, schemaIssues, validateSchema } from "../src/structured-output/validator.ts";

const cases: [string, unknown, unknown, boolean, string?][] = [
  ["object required", {}, { type: "object", required: ["x"] }, false, "/x"],
  ["object properties", { x: 3 }, { properties: { x: { type: "string" } } }, false, "/x"],
  ["additional property", { extra: 1 }, { additionalProperties: false }, false, "/extra"],
  ["additional schema", { extra: 1 }, { additionalProperties: { type: "integer" } }, true],
  ["additional schema mismatch", { extra: true }, { additionalProperties: { type: "integer" } }, false, "/extra"],
  ["array items", [1, "two"], { type: "array", items: { type: "integer" } }, false, "/1"],
  ["integer", 1.5, { type: "integer" }, false, ""],
  ["number", 1.5, { type: "number" }, true],
  ["boolean", false, { type: "boolean" }, true],
  ["null", null, { type: "null" }, true],
  ["nullable", null, { type: "string", nullable: true }, true],
  ["nullable still checks enum", null, { type: "string", nullable: true, enum: ["x"] }, false, ""],
  ["nullable still checks const", null, { type: "string", nullable: true, const: "x" }, false, ""],
  ["type array null", null, { type: ["string", "null"] }, true],
  ["type array wrong", 1, { type: ["string", "null"] }, false, ""],
  ["enum ordered objects", { b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }, true],
  ["enum wrong", "b", { enum: ["a"] }, false, ""],
  ["const array", [1, 2], { const: [1, 2] }, true],
  ["const mismatch", [2, 1], { const: [1, 2] }, false, ""],
  ["anyOf", "s", { anyOf: [{ type: "string" }, { type: "null" }] }, true],
  ["anyOf mismatch", 2, { anyOf: [{ type: "string" }, { type: "null" }] }, false, ""],
  ["string min", "a", { minLength: 2 }, false, ""],
  ["string max", "ab", { maxLength: 1 }, false, ""],
  ["unicode length", "🧭", { type: "string", minLength: 1, maxLength: 1 }, true],
  ["minimum", 1, { minimum: 2 }, false, ""],
  ["maximum", 3, { maximum: 2 }, false, ""],
  ["exclusive minimum", 2, { exclusiveMinimum: 2 }, false, ""],
  ["exclusive maximum", 2, { exclusiveMaximum: 2 }, false, ""],
  ["inclusive bounds", 2, { minimum: 2, maximum: 2 }, true],
  ["min items", [], { minItems: 1 }, false, ""],
  ["max items", [1, 2], { maxItems: 1 }, false, ""],
  ["min properties", {}, { minProperties: 1 }, false, ""],
  ["max properties", { a: 1, b: 2 }, { maxProperties: 1 }, false, ""],
  ["escaped path", { "a/b~": 1 }, { properties: { "a/b~": { type: "string" } } }, false, "/a~1b~0"],
  ["prototype is not required property", {}, { required: ["toString"] }, false, "/toString"],
  ["local reference", { x: 1 }, { properties: { x: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } }, true],
  ["local reference mismatch", { x: "no" }, { properties: { x: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } }, false, "/x"],
  ["boolean schema true", 1, true, true],
  ["boolean schema false", 1, false, false, ""],
];
describe("structured-output schema subset", () => {
  for (const [name, value, schema, valid, path] of cases) test(name, () => {
    const check = validateSchema(value, schema);
    expect(check.valid).toBe(valid);
    if (path !== undefined) expect(check.errors[0].path).toBe(path);
  });
  test("unknown assertions and malformed schemas fail closed", () => {
    for (const schema of [{ pattern: "x" }, { format: "email" }, { oneOf: [] }, { type: "unknown" }, { required: "x" }, { minimum: "2" }, { minLength: -1 }, { anyOf: [] }, { $ref: "https://schema.example/schema" }, { $ref: "#/$defs/missing" }, { properties: [] }, { items: [] }])
      expect(schemaIssues(schema).length).toBeGreaterThan(0);
  });
  test("recursive schemas terminate and errors are capped", () => {
    const schema = { $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" };
    expect(validateSchema({}, schema).valid).toBe(false);
    const check = validateSchema(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 1])), { additionalProperties: false });
    expect(check.errors.length).toBe(16);
  });
  test("JSON parsing never strips markdown and rejects non-object json_object answers", () => {
    for (const text of ["", "```json\n{}\n```", "broken", "[]", "null", "123"])
      expect(checkText(text, { type: "json_object" }).valid).toBe(false);
    expect(checkText(' {"ok":true} \n', { type: "json_object" }).valid).toBe(true);
    expect(checkText('"x"', { type: "json_schema", json_schema: { schema: { type: "string" } } }).valid).toBe(true);
    expect(checkText(null, { type: "json_object" }).errors[0].reason).toContain("not text");
    expect(checkText("x".repeat(1024 * 1024 + 1), { type: "json_object" }).errors[0].reason).toContain("1 MiB");
  });
});
