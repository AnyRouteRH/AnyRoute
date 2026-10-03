import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("secret exceptions bind reviewed bytes and refuse changed secrets or outside paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-fixture-test-"));
  try {
    const code = `
import hashlib, importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('scanner', 'scripts/scan-secrets.py')
scanner = importlib.util.module_from_spec(spec); spec.loader.exec_module(scanner)
root = pathlib.Path(sys.argv[1]).resolve()
path = root / 'fixture.txt'; path.write_text('fixture-only-placeholder\\n')
finding = {'File': 'fixture.txt', 'RuleID': 'test', 'StartLine': 1, 'EndLine': 1}
exceptions = [{'file': 'fixture.txt', 'rule': 'test', 'start': 1, 'end': 1, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}]
assert scanner.approved_tree(finding, exceptions, root)
path.write_text('changed-placeholder\\n')
assert not scanner.approved_tree(finding, exceptions, root)
assert not scanner.approved_tree({**finding, 'File': '../outside.txt'}, exceptions, root)
assert not scanner.approved_tree({**finding, 'EndLine': 100}, exceptions, root)
`;
    const result = Bun.spawnSync(["python3", "-c", code, dir], { stderr: "pipe", stdout: "pipe" });
    expect(result.exitCode).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
