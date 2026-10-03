// The /facilitator page: copy-paste examples and a plain reading of GET /api/v1/status data.facilitator.

export const FACILITATOR_PATH = '/facilitator';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

/** One sentence about whether this router's facilitator is on, from the status endpoint. Never claims more than it says. */
export function describeFacilitator(status) {
  const f = status?.facilitator;
  if (!f) return { on: false, text: 'This router does not report a facilitator.' };
  if (!f.enabled) return { on: false, text: 'Not switched on at this router yet: every /facilitator address answers 503 facilitator_disabled.' };
  const usdg = units => (Number(units) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
  const fee = f.fee_bps === 0 ? 'no fee during the launch waiver' : `a fee of ${f.fee_bps / 100}%`;
  const parts = [`Switched on at this router for ${f.networks.join(', ')}`, fee, `minimum ${usdg(f.min_settle_units)} USDG${f.gas_floats ? ' unless the seller prepaid a gas float' : ''}`];
  if (f.relay?.above_floor === false) parts.push('the relay is below its gas floor, so settles are refused until it is funded');
  return { on: true, text: parts.join('; ') + '.' };
}

export const SELLER_EXAMPLE = `// Your server received a buyer's x402 payment and decoded it to paymentPayload.
const FACILITATOR = "https://anyroute.tech/facilitator";
const paymentRequirements = {
  scheme: "exact",
  network: "eip155:4663",
  amount: "10000", // 0.01 USDG (6 decimals)
  asset: "${USDG}",
  payTo: "0xYourAddress",
  maxTimeoutSeconds: 60,
  extra: { name: "Global Dollar", version: "1" },
};
const post = (path, body) =>
  fetch(FACILITATOR + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const check = await post("/verify", { paymentPayload, paymentRequirements });
if (!check.isValid) return reply402(check.invalidReason);
const answer = await doTheWork();
const settled = await post("/settle", { paymentPayload, paymentRequirements });
if (!settled.success) return reply402(settled.errorReason);
// settled.transaction: the Robinhood Chain transaction. settled.receipt.url: its signed receipt.`;

export const LISTING_EXAMPLE = `import { privateKeyToAccount } from "viem/accounts";

const seller = privateKeyToAccount(process.env.PAY_TO_KEY); // the key behind your payTo address
const listing = {
  payTo: seller.address,
  resource: "https://api.example.com/quote",
  priceHint: 10000n,
  outputSchema: JSON.stringify({ type: "object", properties: { price: { type: "number" } } }),
  tags: ["quotes"],
  listed: true,
  issuedAt: BigInt(Math.floor(Date.now() / 1000)),
};
const { policy } = await (await fetch("https://anyroute.tech/facilitator/supported")).json();
const signature = await seller.signTypedData({ ...policy.listing, message: listing });
await fetch("https://anyroute.tech/facilitator/sellers", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...listing, priceHint: "10000", issuedAt: Number(listing.issuedAt), signature }),
});`;
