import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("web/public/network/check.sh");
async function run(files: Record<string, string>, gpu = "none", state = "ON", caps = "CC Capable") {
  const root = mkdtempSync(join(tmpdir(), "network-check-"));
  try {
    for (const [name, value] of Object.entries(files)) { const file = join(root, name); mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, value); }
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "nvidia-smi"), `#!/bin/sh\nset -eu\n[ "$GPU_FIXTURE" != none ] || exit 1\ncase "$*" in\n--query-gpu=*) [ "$GPU_FIXTURE" != none ] || exit 1; printf '%s\\n' "$GPU_FIXTURE" ;;\n'conf-compute -q') printf 'CC State : %s\\nGPU CC Capabilities : %s\\n' "$CC_FIXTURE" "$CAP_FIXTURE" ;;\n'conf-compute -gg') exit 1 ;;\n*) exit 1 ;;\nesac\n`, { mode: 0o755 });
    const process = Bun.spawn(["sh", script], { env: { ...Bun.env, ANYROUTE_CHECK_ROOT: root, PATH: `${bin}:/usr/bin:/bin`, GPU_FIXTURE: gpu, CC_FIXTURE: state, CAP_FIXTURE: caps }, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(code).toBe(0); expect(error).toBe(""); expect(out.match(/^AnyRoute readiness:/gm)?.length).toBe(1);
    expect(out).toContain("This is a hint, not attestation"); expect(out).toContain("Nothing is changed or sent");
    return out;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("TDX guest devices, including alternate spelling", async () => { for (const device of ["dev/tdx_guest", "dev/tdx-guest"]) expect(await run({ [device]: "" })).toContain("TDX guest=yes"); });
test("SEV-SNP guest and enabled bare-metal host hints", async () => {
  expect(await run({ "dev/sev-guest": "" })).toContain("SEV-SNP guest=yes");
  expect(await run({ "sys/module/kvm_amd/parameters/sev_snp": "Y\n" })).toContain("SEV-SNP host=enabled-hint");
  expect(await run({ "sys/module/kvm_intel/parameters/tdx": "1\n" })).toContain("TDX host=enabled-hint");
});
test("CPU flags are hints; generic SEV is not SEV-SNP", async () => {
  expect(await run({ "proc/cpuinfo": "flags : sev sev_snp tdx\n" })).toContain("SEV-SNP host=cpu-hint");
  expect(await run({ "proc/cpuinfo": "flags : sev\n" })).toContain("SEV-SNP host=unknown");
});
test("GPU counts, driver and CC mode; off and devtools never imply on", async () => {
  const cards = "NVIDIA H100 80GB, 570.124\nNVIDIA H100 80GB, 570.124";
  const out = await run({}, cards); expect(out).toContain("GPU=2xNVIDIA H100 80GB"); expect(out).toContain("GPU CC=on"); expect(out).toContain("driver=570.124"); expect(out).toContain("GPU CC capability=reported");
  expect(await run({}, cards, "OFF")).toContain("GPU CC=off");
  expect(await run({}, cards, "DEVTOOLS")).toContain("GPU CC=mixed-or-unknown");
});
test("nothing found is unknown, not a claim of eligibility", async () => {
  const out = await run({}, "none", "N/A", "N/A"); expect(out).toContain("GPU=none-detected"); expect(out).toContain("TDX guest=no"); expect(out).toContain("GPU CC=unknown"); expect(out).toContain("sudo may give a better answer");
});
