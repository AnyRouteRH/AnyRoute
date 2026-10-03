import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
test("combined coverage deduplicates shared clients and refuses a threshold with missing source", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'core-line-coverage-'));
  try {
    const scope = join(dir, 'scope.txt'); const left = join(dir, 'left.lcov'); const right = join(dir, 'right.lcov');
    await writeFile(scope, 'src/sample.ts\n');
    await writeFile(left, 'SF:src/sample.ts\nDA:1,1\nDA:2,0\nend_of_record\n');
    await writeFile(right, 'SF:src/sample.ts\nDA:1,0\nDA:2,1\nend_of_record\n');
    const args = ['scripts/core-coverage.py', '--scope', scope, '--lcov', `.:${left}`, '--lcov', `.:${right}`, '--minimum', '95'];
    let result = spawnSync('python3', args, { encoding: 'utf8' });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ measuredLines: 2, coveredMeasuredLines: 2, complete: true });
    await writeFile(scope, 'src/sample.ts\nsrc/unmeasured.ts\n'); result = spawnSync('python3', args, { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, unmeasuredSourceFiles: ['src/unmeasured.ts'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("combined coverage accepts only successful artifacts from the required revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'core-revision-coverage-'));
  try {
    const scope = join(dir, 'scope.txt');
    const artifact = join(dir, 'coverage.lcov');
    const revision = 'a'.repeat(40);
    await writeFile(scope, 'src/sample.ts\n');
    await writeFile(artifact, 'SF:src/sample.ts\nDA:1,1\nend_of_record\n');
    await writeFile(join(dir, 'source-revision.txt'), revision);
    await writeFile(join(dir, 'test-outcome.txt'), 'success');
    const args = ['scripts/core-coverage.py', '--scope', scope, '--lcov', `.:${artifact}`, '--require-revision', revision];
    let result = spawnSync('python3', args, { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: true, coveredMeasuredLines: 1 });

    await writeFile(join(dir, 'source-revision.txt'), 'b'.repeat(40));
    result = spawnSync('python3', args, { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('different source revisions');
    expect(result.stdout).toBe('');

    await writeFile(join(dir, 'source-revision.txt'), revision);
    await writeFile(join(dir, 'test-outcome.txt'), 'failure');
    result = spawnSync('python3', args, { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsuccessful test run');
    expect(result.stdout).toBe('');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
