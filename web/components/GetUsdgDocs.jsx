// ON1: payment guide; addresses remain in the router's live instructions.
export default function GetUsdgDocs() {
  return <section aria-labelledby="get-usdg"><h3 id="get-usdg">How do I get USDG?</h3>
    <p>USDG deposits are not switched on at anyroute.tech yet. Today you add funds with $ANYR or a listed stock token (see below); this guide is for when USDG is switched on, or for routers that already accept it.</p>
    <p>USDG is a US dollar stablecoin used for prepaid calls. For Anyroute deposits, it must be on Robinhood Chain (chain ID 4663). A token on another chain does not fund your account here.</p>
    <p>You can buy USDG where it is available, or bridge it from a supported chain using a service that supports USDG on Robinhood Chain. Check the destination chain, supported token, fees and withdrawal details before confirming. You also need ETH on Robinhood Chain for wallet transaction fees.</p>
    <p>Sign in, open <a className="inline-link" href="/dashboard/#payments">Add funds</a>, and use the token and destination addresses returned by the router. A USDG Credits deposit needs approval and a deposit call; sending tokens directly to the Credits contract does not credit your key.</p>
    <p>USDG sent from the wallet you signed in with to the router’s escrow address is credited 1:1 at anyroute.tech once switched on. <code>GET /api/v1/status</code> reports it as <code>escrow.usdg.enabled</code> (self-hosted routers: <code>USDG_ESCROW_ENABLED</code>, default false). The same chain finality, early-credit cap and per-deposit limit apply, and Add funds lists USDG first when it is on.</p>
    <p>$ANYR and listed stock tokens are also accepted through escrow where the router enables them. Send from the wallet you signed in with. Credits wait for confirmation and a current rate, with the haircut and any per-deposit limit shown in the payment instructions. Tokens remain in escrow and credits pay for API calls.</p>
  </section>;
}
