/** All values are pico-USD. The first input is priced from a verified chain log, never a form. */
export function provisionalCreditAmount(observedValue: bigint, accountRoom: bigint, globalRoom: bigint) {
  const amount = [observedValue, accountRoom, globalRoom].reduce((a, b) => a < b ? a : b);
  return amount > 0n ? amount : 0n;
}
