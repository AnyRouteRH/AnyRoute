// H166: copied comparison history shares reply ids, but new continuation calls are distinct.
export function continuationCostAdjustment(lanes, costUnits) {
  const groups = new Map();
  for (const lane of lanes) for (const message of lane.messages || []) {
    if (message.role !== 'assistant' || !message.id) continue;
    const group = groups.get(message.id) || [];
    group.push(message); groups.set(message.id, group);
  }
  let adjustment = 0n;
  for (const [id, group] of groups) {
    if (group.length < 2 || !group.some(message => message.continuationCalls?.length)) continue;
    const calls = new Map();
    for (const message of group) {
      if (message.status === 'error') continue;
      const records = message.continuationCalls || [{ cost: message.usage?.cost ?? Number(message.receipt?.payload?.cost) }];
      records.forEach((call, index) => {
        // The first call is the same copied reply, regardless of whether its receipt arrived.
        const key = index === 0 ? id : call.callId || call.receiptId;
        if (key && Number.isFinite(call.cost)) calls.set(key, call.cost);
      });
    }
    const cost = [...calls.values()].reduce((total, value) => total + value, 0);
    adjustment += costUnits({ usage: { cost } }) - costUnits(group[0]);
  }
  return adjustment;
}
