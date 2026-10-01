import type { Ctx } from '../../context.ts';
import { runAttestor } from '../../services/attestor.ts';
import { runSealedAttestor } from './store.ts';
/** Use the existing attestor schedule and worker role; preserve its result and disabled behavior. */
export async function runAttestorWithSealed(ctx: Ctx) {
  if (!ctx.cfg.agentSealedEnabled) return runAttestor(ctx);
  const [result] = await Promise.all([runAttestor(ctx), runSealedAttestor(ctx)]);
  return result;
}
