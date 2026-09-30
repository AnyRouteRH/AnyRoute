export function usdgAmount(units) {
  if (typeof units !== 'string' || !/^\d{1,78}$/.test(units)) return 'Unknown';
  const raw = BigInt(units);
  const fraction = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${raw / 1_000_000n}${fraction ? `.${fraction}` : ''} USDG`;
}
export function bondTransaction(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash || '') ? `https://robinhoodchain.blockscout.com/tx/${hash}` : '';
}
export function describeBond(bond) {
  if (!bond) return null;
  return { ...bond, amount: usdgAmount(bond.amount_units), active: usdgAmount(bond.active_units),
    queued: bond.unbonding ? usdgAmount(bond.unbonding.amount_units) : null,
    slashes: (Array.isArray(bond.slashes) ? bond.slashes : []).map(s => ({ ...s, amount: usdgAmount(s.amount_units), transactions: (Array.isArray(s.transactions) ? s.transactions : []).map(t => ({ ...t, href: bondTransaction(t.hash) })).filter(t => t.href) })) };
}
