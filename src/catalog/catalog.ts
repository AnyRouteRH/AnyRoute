import { desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { laneCandidates, measurements, models, modelsLane, offers, providerDisclosure, providers } from "../db/schema.ts";
import { loadTlsPin, loadTlsPins, type TlsPin } from "../providers/tls-pin.ts";
import { loadAciGateway, loadAciGateways, loadGpuAttested, type AciGateway, type GpuAttestedRecord } from "../providers/aci.ts";
import { loadAttestedPolicies, loadAttestedPolicy, type AttestedPolicy } from "../providers/attested-policy.ts";
import { laneOf } from "../router/lane.ts";

export type ModelRow = typeof models.$inferSelect;
export type OfferRow = typeof offers.$inferSelect;
/** A provider row, plus the certificate its connections are pinned to once it attested through a self-signed
 *  certificate (providers/tls-pin.ts), for an attested aci/1 gateway what its attestation established
 *  (providers/aci.ts), and the classifier policy hash its last verified attestation bound (providers/attested-policy.ts). */
export type ProviderRow = typeof providers.$inferSelect & { tlsPin?: TlsPin | null; aci?: AciGateway | null; attestedPolicy?: AttestedPolicy | null };
/**
 * Where a provider's current measurement stands in the transparency log and the on-chain registry
 * (services/measurements.ts): each field only once it was checked, null until then.
 */
export type ManifestRef = { rekor_entry: string | null; registry_tx: string | null };
export type DisclosureRow = typeof providerDisclosure.$inferSelect;
export type ModelLaneRow = typeof modelsLane.$inferSelect;
export type Candidate = OfferRow & { provider: ProviderRow };

// Routing suffixes: `author/model:nitro` (fastest), `:floor` (cheapest), `:free` (free offers
// only), `:private` (attested TEE providers only). Other suffixes are part of the model id.
export const ROUTING_SUFFIXES = ["nitro", "floor", "free", "private"] as const;
export type Modifier = (typeof ROUTING_SUFFIXES)[number];

export class Catalog {
  models = new Map<string, ModelRow>();
  providers = new Map<string, ProviderRow>();
  offersByModel = new Map<string, Candidate[]>();
  /** Operator-declared disclosure profiles by provider id; a provider without a row is treated as undeclared. */
  disclosure = new Map<string, DisclosureRow>();
  /** Operator-declared variant metadata by model id; a model without a row is classified by laneOf. */
  lane = new Map<string, ModelLaneRow>();
  /** Day-zero candidates by lower-cased Hugging Face repository: a model listed for one is held back until it is servable. */
  candidates = new Map<string, { variant: string; status: string }>();
  /** Per model, what the latest verified gateway receipt said about GPU attestation (providers/aci.ts). */
  gpuAttested = new Map<string, GpuAttestedRecord>();
  /** Per provider, the log entry and registry transaction of the measurement its attestations bound most recently. */
  manifests = new Map<string, ManifestRef>();
  loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private db: Db) {}

  async refresh() {
    this.loading ??= (async () => {
      try {
        const [m, p, o, d, pins, l, cand, gateways, gpu, policies, meas] = await Promise.all([
          this.db.select().from(models),
          this.db.select().from(providers),
          this.db.select().from(offers),
          this.db.select().from(providerDisclosure),
          loadTlsPins(this.db),
          this.db.select().from(modelsLane),
          this.db.select({ hfRepo: laneCandidates.hfRepo, variant: laneCandidates.variant, status: laneCandidates.status }).from(laneCandidates),
          loadAciGateways(this.db),
          loadGpuAttested(this.db),
          loadAttestedPolicies(this.db),
          this.db
            .select({ providerId: measurements.providerId, status: measurements.status, rekorUuid: measurements.rekorUuid, rekorInclusionVerified: measurements.rekorInclusionVerified, txHash: measurements.txHash })
            .from(measurements)
            .where(isNull(measurements.revokedAt))
            .orderBy(desc(measurements.lastSeenAt)),
        ]);
        const pm = new Map<string, ProviderRow>(p.map((x) => [x.id, { ...x, tlsPin: pins.get(x.id) ?? null, aci: gateways.get(x.id) ?? null, attestedPolicy: policies.get(x.id) ?? null }]));
        // The measurement a provider's attestations bound most recently (rows are ordered newest first).
        const manifests = new Map<string, ManifestRef>();
        for (const r of meas) {
          if (manifests.has(r.providerId)) continue;
          manifests.set(r.providerId, { rekor_entry: r.rekorInclusionVerified ? r.rekorUuid : null, registry_tx: r.status === "registered" ? r.txHash : null });
        }
        const byModel = new Map<string, Candidate[]>();
        for (const offer of o) {
          const provider = pm.get(offer.providerId);
          if (!provider) continue;
          const list = byModel.get(offer.modelId) ?? [];
          list.push({ ...offer, provider });
          byModel.set(offer.modelId, list);
        }
        this.models = new Map(m.map((x) => [x.id, x]));
        this.providers = pm;
        this.disclosure = new Map(d.map((x) => [x.providerId, x]));
        this.lane = new Map(l.map((x) => [x.modelId, x]));
        this.candidates = new Map(cand.map((x) => [x.hfRepo.toLowerCase(), { variant: x.variant, status: x.status }]));
        this.offersByModel = byModel;
        this.gpuAttested = gpu;
        this.manifests = manifests;
        this.loadedAt = Date.now();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  async ensureFresh(maxAgeMs = 5_000) {
    if (Date.now() - this.loadedAt > maxAgeMs) await this.refresh();
  }

  /** Resolve `author/model[:suffix...]` into a catalog model plus routing modifiers. */
  resolve(param: string): { model: ModelRow; modifiers: Set<Modifier> } | null {
    if (typeof param !== "string" || !param) return null;
    const direct = this.models.get(param);
    if (direct) return { model: direct, modifiers: new Set() };
    const parts = param.split(":");
    const modifiers = new Set<Modifier>();
    while (parts.length > 1 && (ROUTING_SUFFIXES as readonly string[]).includes(parts[parts.length - 1])) {
      modifiers.add(parts.pop() as Modifier);
      const id = parts.join(":");
      const m = this.models.get(id);
      if (m) return { model: m, modifiers };
    }
    return null;
  }

  /** The variant a model is routed under (see router/lane.ts): its declared row, else its name, else mainstream. */
  laneOf(model: ModelRow) {
    return laneOf(model, this.lane.get(model.id), model.hfRepo ? this.candidates.get(model.hfRepo.toLowerCase()) : null);
  }

  offers(modelId: string) {
    return this.offersByModel.get(modelId) ?? [];
  }

  async provider(id: string) {
    const cached = this.providers.get(id);
    if (cached) return cached;
    const [row] = await this.db.select().from(providers).where(eq(providers.id, id));
    return row ? { ...row, tlsPin: await loadTlsPin(this.db, id), aci: await loadAciGateway(this.db, id), attestedPolicy: await loadAttestedPolicy(this.db, id) } : null;
  }
}
