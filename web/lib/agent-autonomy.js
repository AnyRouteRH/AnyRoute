// Keep optional rulebook settings intact when the existing form edits other fields.
export const autonomyForm = policy => policy?.autonomy === undefined ? {} : { autonomy: policy.autonomy };
export const autonomyPolicy = form => form.autonomy === undefined ? {} : { autonomy: form.autonomy };
export function autonomyLadder(policy, progress) {
  if (!policy?.autonomy || !progress) return [];
  return [{ rung:0,caps_multiplier:1,after_days:0,clean_requests:0 }, ...policy.autonomy.rungs.map((r,i) => ({ ...r,rung:i+1 }))]
    .map(r => ({ ...r,current:r.rung === progress.rung,reached:r.rung <= progress.rung }));
}
