import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SidecarError } from "../util.ts";
import { UsageError } from "./args.ts";
import type { DataPolicy, Server, Target } from "./spec.ts";

// What `init` records for the commands that follow it (`apply`, `doctor`). It holds no secret: the router key stays in its
// own file and only its SHA-256 appears here.

export const FILES = {
  yaml: "sidecar.yaml",
  compose: "docker-compose.yml",
  manifest: "anyroute-provider.json",
  key: "router-api-key",
  applicationJson: "provider-application.json",
  applicationToken: "application-token",
  gitignore: ".gitignore",
} as const;

export type Manifest = {
  v: 1;
  type: "anyroute.provider.onboarding";
  sidecar_cli_version: string;
  target: Target;
  server: Server;
  provider: { id: string; name: string; contact?: string; datacenters: string[]; payout_address?: string; data_policy: DataPolicy };
  model: { served_name: string; digest: string; files: number; bytes: number; weights_path: string; exclude: string[]; hf?: { repo: string; revision: string } };
  sidecar: { repo: string; commit: string; tarball_sha256: string; runtime_image_digest: string };
  model_image: string;
  compose_sha256: string;
  router_key_sha256: string;
  endpoint?: string;
};

export function readManifest(dir: string): Manifest {
  const path = join(dir, FILES.manifest);
  if (!existsSync(path)) throw new UsageError(`${path} not found: run \`init\` first, or pass --dir <the directory init wrote>`);
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch (e) {
    throw new SidecarError("BAD_MANIFEST", `${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (m?.type !== "anyroute.provider.onboarding" || m.v !== 1 || !m.provider?.id || !m.model?.digest) throw new SidecarError("BAD_MANIFEST", `${path} is not an onboarding manifest written by this tool`);
  return m;
}
