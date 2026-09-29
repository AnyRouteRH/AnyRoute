import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { assertClassifierAllowlistConfigured, assertModelAllowlistConfigured, enforceClassifierPin, digestFromManifest, enforceComposePin, enforceModelPin, hashModelPath, loadAllowlist, parseAllowlistText } from "../src/digest.ts";
import { SidecarError } from "../src/util.ts";
import { cleanup, tmpDir, writeFiles } from "./helpers.ts";

afterEach(cleanup);

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as SidecarError).code;
  }
  return null;
};

describe("model digest", () => {
  test("is deterministic and independent of creation order", async () => {
    const a = tmpDir();
    const b = tmpDir();
    writeFiles(a, { "config.json": "{}", "w/shard-1.bin": "one", "w/shard-2.bin": "two" });
    writeFiles(b, { "w/shard-2.bin": "two", "w/shard-1.bin": "one", "config.json": "{}" });
    const ha = await hashModelPath(a);
    const hb = await hashModelPath(b);
    expect(ha.digest).toBe(hb.digest);
    expect(ha.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ha.files).toBe(3);
    expect(ha.bytes).toBe(2 + 3 + 3);
    expect(ha.manifest.map((m) => m.path)).toEqual(["config.json", "w/shard-1.bin", "w/shard-2.bin"]);
  });

  test("changes when a byte, a name or a file changes", async () => {
    const a = tmpDir();
    writeFiles(a, { "w.bin": "weights", "c.json": "{}" });
    const base = (await hashModelPath(a)).digest;
    const b = tmpDir();
    writeFiles(b, { "w.bin": "weightz", "c.json": "{}" });
    expect((await hashModelPath(b)).digest).not.toBe(base);
    const c = tmpDir();
    writeFiles(c, { "w2.bin": "weights", "c.json": "{}" });
    expect((await hashModelPath(c)).digest).not.toBe(base);
    const d = tmpDir();
    writeFiles(d, { "w.bin": "weights", "c.json": "{}", "extra.txt": "x" });
    expect((await hashModelPath(d)).digest).not.toBe(base);
  });

  test("matches the documented construction", async () => {
    const a = tmpDir();
    writeFiles(a, { "a.txt": "A" });
    const h = await hashModelPath(a);
    const sha = h.manifest[0].sha256;
    expect(h.digest).toBe(digestFromManifest([{ path: "a.txt", sha256: sha }]));
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`anyroute-model-digest-v1\n[["a.txt","${sha}"]]`);
    expect(h.digest).toBe(`sha256:${hasher.digest("hex")}`);
  });

  test("skips .git and .cache, honours exclude globs, follows symlinks to files", async () => {
    const a = tmpDir();
    writeFiles(a, { "w.bin": "w", ".git/HEAD": "ref", ".cache/x": "y", "README.md": "docs" });
    const plain = await hashModelPath(a, { exclude: ["README.md"] });
    expect(plain.manifest.map((m) => m.path)).toEqual(["w.bin"]);
    const other = tmpDir();
    writeFiles(other, { "real.bin": "w" });
    symlinkSync(join(other, "real.bin"), join(a, "linked.bin"));
    const linked = await hashModelPath(a, { exclude: ["README.md"] });
    expect(linked.manifest.map((m) => m.path)).toEqual(["linked.bin", "w.bin"]);
  });

  test("accepts a single file and refuses missing or empty paths and symlink loops", async () => {
    const a = tmpDir();
    writeFiles(a, { "model.gguf": "gguf" });
    expect((await hashModelPath(join(a, "model.gguf"))).files).toBe(1);
    expect(hashModelPath(join(a, "nope"))).rejects.toMatchObject({ code: "MODEL_UNREADABLE" });
    const empty = tmpDir();
    expect(hashModelPath(empty)).rejects.toMatchObject({ code: "MODEL_EMPTY" });
    const loop = tmpDir();
    mkdirSync(join(loop, "d"));
    writeFiles(loop, { "d/f": "x" });
    symlinkSync(loop, join(loop, "d", "back"));
    expect(hashModelPath(loop)).rejects.toMatchObject({ code: "MODEL_UNREADABLE" });
  });
});

describe("allow-lists", () => {
  const d1 = `sha256:${"aa".repeat(32)}`;
  const d2 = `sha256:${"bb".repeat(32)}`;

  test("parse files with comments and blank lines", () => {
    expect(parseAllowlistText(`# approved\n${d1}\n\n  ${"bb".repeat(32)}  # second\n`, "model")).toEqual([d1, d2]);
    expect(() => parseAllowlistText("not-a-digest", "model")).toThrow();
  });

  test("merge config, file and environment sources", async () => {
    const dir = tmpDir();
    writeFiles(dir, { "models.txt": `${d2}\n` });
    const allow = await loadAllowlist({ modelDigests: [d1], modelDigestsFile: join(dir, "models.txt"), composeHashes: [], composeHashesFile: undefined }, { SIDECAR_MODEL_ALLOWLIST: `0x${"cc".repeat(32)}` });
    expect([...allow.modelDigests].sort()).toEqual([d1, d2, `sha256:${"cc".repeat(32)}`].sort());
  });

  test("an unreadable list file is an error, not an empty list", async () => {
    expect(loadAllowlist({ modelDigests: [], modelDigestsFile: "/nonexistent/list.txt", composeHashes: [] }, {})).rejects.toMatchObject({ code: "ALLOWLIST_UNREADABLE" });
  });

  test("the model pin refuses an empty list and any digest not on it", async () => {
    const empty = await loadAllowlist({ modelDigests: [], composeHashes: [] }, {});
    expect(codeOf(() => assertModelAllowlistConfigured(empty))).toBe("MODEL_ALLOWLIST_EMPTY");
    expect(codeOf(() => enforceModelPin(d1, empty))).toBe("MODEL_ALLOWLIST_EMPTY");
    const allow = await loadAllowlist({ modelDigests: [d1], composeHashes: [] }, {});
    expect(codeOf(() => enforceModelPin(d1, allow))).toBeNull();
    expect(codeOf(() => enforceModelPin(d2, allow))).toBe("MODEL_DIGEST_NOT_ALLOWED");
  });

  test("the compose pin applies only when a list is configured", async () => {
    const none = await loadAllowlist({ modelDigests: [d1], composeHashes: [] }, {});
    expect(codeOf(() => enforceComposePin(null, none))).toBeNull();
    const some = await loadAllowlist({ modelDigests: [d1], composeHashes: [d2] }, {});
    expect(codeOf(() => enforceComposePin(d2, some))).toBeNull();
    expect(codeOf(() => enforceComposePin(d1, some))).toBe("COMPOSE_HASH_NOT_ALLOWED");
    expect(codeOf(() => enforceComposePin(null, some))).toBe("COMPOSE_HASH_MISSING");
  });

  test("the classifier has its own list, merged from config, file and environment, and never shares entries with the model list", async () => {
    const dir = tmpDir();
    writeFiles(dir, { "classifiers.txt": `${d2}\n` });
    const allow = await loadAllowlist(
      { modelDigests: [d1], composeHashes: [], classifierDigests: [d1], classifierDigestsFile: join(dir, "classifiers.txt") },
      { SIDECAR_CLASSIFIER_ALLOWLIST: `0x${"cc".repeat(32)}`, SIDECAR_MODEL_ALLOWLIST: `0x${"dd".repeat(32)}` },
    );
    expect([...allow.classifierDigests].sort()).toEqual([d1, d2, `sha256:${"cc".repeat(32)}`].sort());
    expect(allow.modelDigests.has(`sha256:${"cc".repeat(32)}`)).toBe(false);
    expect(allow.classifierDigests.has(`sha256:${"dd".repeat(32)}`)).toBe(false);
  });

  test("the classifier pin refuses an empty list and any digest not on it, even one the model list has", async () => {
    const modelOnly = await loadAllowlist({ modelDigests: [d1], composeHashes: [] }, {});
    expect(codeOf(() => assertClassifierAllowlistConfigured(modelOnly))).toBe("CLASSIFIER_ALLOWLIST_EMPTY");
    expect(codeOf(() => enforceClassifierPin(d1, modelOnly))).toBe("CLASSIFIER_ALLOWLIST_EMPTY");
    const both = await loadAllowlist({ modelDigests: [d1], composeHashes: [], classifierDigests: [d2] }, {});
    expect(codeOf(() => enforceClassifierPin(d2, both))).toBeNull();
    expect(codeOf(() => enforceClassifierPin(d1, both))).toBe("CLASSIFIER_DIGEST_NOT_ALLOWED");
  });
});
