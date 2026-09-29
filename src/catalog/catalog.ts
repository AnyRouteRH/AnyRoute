import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { laneCandidates, models, modelsLane, offers, providerDisclosure, providers } from "../db/schema.ts";
import { loadTlsPin, loadTlsPins, type TlsPin } from "../providers/tls-pin.ts";
import { laneOf } from "../router/lane.ts";

export type ModelRow = typeof models.$inferSelect;
export type OfferRow = typeof offers.$inferSelect;
/** A provider row, plus the certificate its connections are pinned to once it attested through a self-signed
 *  certificate (providers/tls-pin.ts). */
export type ProviderRow = typeof providers.$inferSelect & { tlsPin?: TlsPin | null };
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
  loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private db: Db) {}

  async refresh() {
    this.loading ??= (async () => {
      try {
        const [m, p, o, d, pins, l, cand] = await Promise.all([
          this.db.select().from(models),
          this.db.select().from(providers),
          this.db.select().from(offers),
          this.db.select().from(providerDisclosure),
          loadTlsPins(this.db),
          this.db.select().from(modelsLane),
          this.db.select({ hfRepo: laneCandidates.hfRepo, variant: laneCandidates.variant, status: laneCandidates.status }).from(laneCandidates),
        ]);
        const pm = new Map<string, ProviderRow>(p.map((x) => [x.id, { ...x, tlsPin: pins.get(x.id) ?? null }]));
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
    return row ? { ...row, tlsPin: await loadTlsPin(this.db, id) } : null;
  }
}
