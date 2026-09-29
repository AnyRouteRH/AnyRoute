export type AttestationKind = "dstack" | "tdx" | "dev";

export type QuoteEvidence = {
  kind: AttestationKind;
  /** True only for simulated evidence. Never true for a hardware provider. */
  dev: boolean;
  format: "tdx-quote-v4" | "dev-simulated";
  /** Hex of the quote bytes exactly as the platform returned them. */
  quote: string;
  /** Hex of the 64-byte report_data the quote was requested for (checked against the quote for hardware kinds). */
  reportData: string;
  /** Platform event log (dstack) as a JSON string, when the platform supplies one. */
  eventLog: string | null;
  /** Measurement registers read out of the quote (hardware kinds) or a simulated marker (dev). */
  measurements: Record<string, string>;
  generatedAt: string;
};

export type PlatformInfo = {
  /** sha256 of the deployment (compose) manifest as the platform measured it, when it reports one. */
  composeHash?: string;
  appId?: string;
  instanceId?: string;
};

/** Source of hardware (or, in development, simulated) evidence for the sidecar's report data. */
export interface AttestationProvider {
  readonly kind: AttestationKind;
  /** Facts the platform can report about the deployment before a quote is requested. */
  platformInfo(): Promise<PlatformInfo>;
  /** Request a quote whose report_data equals `reportData` (64 bytes). */
  quote(reportData: Uint8Array): Promise<QuoteEvidence>;
}
