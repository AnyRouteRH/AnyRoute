"use client";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { shortAddress } from "../../lib/wallet";
import { Button } from "../UI";
import ContractAddress, { ANYR_CA } from "../ContractAddress";
import styles from "./Holders.module.css";

/**
 * Holders workspace tab. Props (from Dashboard): { live, apiKey, status, signedIn, navigate }.
 * Live: GET /api/v1/holder for the signed-in key (balance, tier, perks, ladder, free credits), and the
 * public tier ladder from GET /api/v1/status (`holders`) before sign-in.
 * live=false is the explicit sample workspace: every figure is generated here and labelled as sample.
 */

// ---- holders pure helpers: begin (plain JS; web/tests/holders.test.mjs loads this block) ----
/** "2450000.5" -> "2,450,000.5" (at most `digits` decimals, trailing zeros dropped). */
export function formatTokens(value, digits = 2) {
  const [whole, frac = ""] = String(value ?? "0").split(".");
  const cut = frac.slice(0, digits).replace(/0+$/, "");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (cut ? "." + cut : "");
}

/** Basis points as a short percentage: 50 -> "0.5%", 100 -> "1%". */
export const bpsText = (bps) => (Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";

export const multiplierText = (m) => Number(m).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "×";

/** What a tier gives, in words. */
export function perkLines(tier, perks) {
  if (!tier) return ["Standard rate limits", "Standard fees"];
  const lines = [multiplierText(tier.rpm_multiplier) + " rate limit"];
  if (perks?.rpm != null) lines.push(perks.rpm === 0 ? "No request limit on this key" : Number(perks.rpm).toLocaleString("en-US") + " requests a minute");
  lines.push(tier.discount_bps ? bpsText(tier.discount_bps) + " off Anyroute fees" : "Standard fees");
  return lines;
}

/** Share of the way to the next tier (0-1), from whole-token decimal strings. */
export function progressTo(balance, next) {
  const b = Number(balance);
  const m = Number(next?.min);
  if (!(m > 0) || !(b >= 0)) return 0;
  return Math.max(0, Math.min(1, b / m));
}

const DAY = 86400000;
/** Deterministic sample, shaped like GET /api/v1/holder and marked `sample`. */
export function sampleHolder(now) {
  const at = (days) => new Date(now - days * DAY).toISOString();
  const tiers = [
    { name: "Holder", min: "100000", rpm_multiplier: 2, discount_bps: 50 },
    { name: "Whale", min: "1000000", rpm_multiplier: 5, discount_bps: 100 },
  ];
  return {
    sample: true,
    enabled: true,
    token: { address: ANYR_CA.toLowerCase(), symbol: "ANYR" },
    wallet: "0x5a17c0ffee4e3d2b1a0987654321fedcba5a17c0",
    balance: "420000",
    balance_error: false,
    tier: tiers[0],
    next_tier: { name: "Whale", min: "1000000", remaining: "580000" },
    perks: { rpm_multiplier: 2, rpm: 1200, tpm: null, discount_bps: 50, fees: { prepaid_bps: 0, per_call_margin_bps: 50, byok_fee_bps: 0 } },
    tiers,
    credits_received: [
      { period: "2026-09", usd: 12.4, at: at(1) },
      { period: "2026-08", usd: 9.75, at: at(31) },
    ],
    credits_total_usd: 22.15,
  };
}
// ---- holders pure helpers: end ----

const usd = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function TokenLine({ token }) {
  const address = token?.address || ANYR_CA;
  if (address.toLowerCase() === ANYR_CA.toLowerCase()) return <ContractAddress />;
  return <code className={styles.address}>{address}</code>;
}

export default function Holders({ live, apiKey, status, signedIn, navigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [sample] = useState(() => sampleHolder(Date.now()));

  useEffect(() => {
    if (!live || !signedIn || !apiKey) return;
    const ctl = new AbortController();
    setLoading(true);
    setError("");
    api("/api/v1/holder", { key: apiKey, signal: ctl.signal })
      .then((r) => setData(r.data))
      .catch((e) => e?.name !== "AbortError" && setError(e.message))
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [live, signedIn, apiKey, nonce]);

  const view = live ? data : sample;
  const pub = status?.holders;
  const enabled = live ? (view?.enabled ?? pub?.enabled ?? false) : true;
  const tiers = view?.tiers ?? pub?.tiers ?? [];
  const token = view?.token ?? pub?.token ?? null;
  const symbol = token?.symbol || "ANYR";
  const tier = view?.tier ?? null;
  const credits = view?.credits_received ?? [];
  const waiting = live && signedIn && !view && !error;

  let standing;
  if (live && !signedIn) standing = "signin";
  else if (waiting) standing = "loading";
  else if (live && error) standing = "error";
  else if (!view?.wallet) standing = "nowallet";
  else if (view.balance_error) standing = "unreadable";
  else if (view.balance == null) standing = "off";
  else standing = "balance";

  const rows = [{ name: "Everyone", min: null, rpm_multiplier: 1, discount_bps: 0 }, ...tiers];
  const current = standing === "balance" && enabled ? (tier ? tier.name : "Everyone") : null;

  return (
    <div className={styles.root}>
      <div className="panel-heading">
        <div>
          <h2>{live ? `Hold $${symbol}. Get more from every call.` : `Hold $${symbol}. Get more from every call (sample).`}</h2>
          <p className="help-text">
            {live
              ? `Your $${symbol} balance is read from Robinhood Chain. A tier raises your rate limits and lowers Anyroute's own fees, and holders receive free inference credits.`
              : "An illustration of this view with a generated wallet and figures. None of it is your balance."}
          </p>
        </div>
        {!live ? <span className="badge dark">Sample data</span> : enabled ? <span className="badge green">Live on Robinhood Chain</span> : <span className="badge">Not live yet</span>}
      </div>

      <section className={styles.standing} aria-label={`Your $${symbol}`}>
        <div className={styles.balance}>
          <span className="eyebrow">{`Your $${symbol}`}</span>
          {standing === "balance" && (
            <>
              <strong className={styles.amount}>
                {formatTokens(view.balance)}
                <small>{symbol}</small>
              </strong>
              <p className={styles.wallet}>
                {shortAddress(view.wallet)}
                {view.sample ? " · sample wallet" : ""}
              </p>
              {enabled && view.next_tier && (
                <div className={styles.progress}>
                  <div className={styles.meter} role="progressbar" aria-label={`Progress to ${view.next_tier.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressTo(view.balance, view.next_tier) * 100)}>
                    <i style={{ transform: `scaleX(${progressTo(view.balance, view.next_tier)})` }} />
                  </div>
                  <span>
                    {formatTokens(view.next_tier.remaining, 0)} {symbol} to {view.next_tier.name}
                  </span>
                </div>
              )}
              {enabled && !view.next_tier && tier && <p className={styles.top}>The top tier.</p>}
            </>
          )}
          {standing === "signin" && (
            <>
              <strong className={styles.message}>Sign in with your wallet to see your balance and tier.</strong>
              <div className="button-row">
                <Button light onClick={() => navigate?.("Overview")}>
                  Sign in
                </Button>
              </div>
            </>
          )}
          {standing === "nowallet" && (
            <>
              <strong className={styles.message}>Holder perks follow a wallet.</strong>
              <p className={styles.sub}>{`This key was not created by wallet sign-in. Sign out in Settings, then sign in with the wallet that holds $${symbol}.`}</p>
              <div className="button-row">
                <Button light onClick={() => navigate?.("Settings")}>
                  Open Settings
                </Button>
              </div>
            </>
          )}
          {standing === "unreadable" && (
            <>
              <strong className={styles.message}>Your balance could not be read just now.</strong>
              <p className={styles.sub}>Standard limits and fees apply until it can be read again.</p>
              <button type="button" className={"text-button " + styles.retry} onClick={() => setNonce((n) => n + 1)} disabled={loading}>
                {loading ? "Checking…" : "Check again"}
              </button>
            </>
          )}
          {standing === "off" && <strong className={styles.message}>Holder perks are not live yet.</strong>}
          {standing === "loading" && (
            <p className={styles.sub} role="status">
              Reading your balance…
            </p>
          )}
          {standing === "error" && (
            <>
              <strong className={styles.message}>Holder status could not be loaded.</strong>
              <p className={styles.sub}>{error}</p>
              <button type="button" className={"text-button " + styles.retry} onClick={() => setNonce((n) => n + 1)} disabled={loading}>
                Retry
              </button>
            </>
          )}
          <div className={styles.token}>
            <TokenLine token={token} />
          </div>
        </div>

        <div className={styles.tier} data-on={enabled && !!tier && standing === "balance" ? "" : undefined}>
          <span className="eyebrow">Your tier</span>
          {!enabled ? (
            <>
              <strong className={styles.tierName}>Holder perks are not live yet.</strong>
              <p className={styles.sub}>Tiers switch on when this router enables them. Free credits you receive are listed below either way.</p>
            </>
          ) : standing === "balance" ? (
            <>
              <strong className={styles.tierName}>{tier ? tier.name : "No tier yet"}</strong>
              <ul className={styles.perks}>
                {(tier ? perkLines(tier, view.perks) : [tiers[0] ? `Hold ${formatTokens(tiers[0].min, 0)} ${symbol} for ${tiers[0].name}` : "Standard rate limits and fees"]).map((line, i) => (
                  <li key={line} style={{ "--i": i }}>
                    {line}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <strong className={styles.tierName}>{tiers.length ? `From ${formatTokens(tiers[0].min, 0)} ${symbol}` : "Tiers are live"}</strong>
              <p className={styles.sub}>Your tier is set by the balance of the wallet you sign in with, checked every few minutes.</p>
            </>
          )}
        </div>
      </section>

      {enabled && tiers.length > 0 && (
        <>
          <div className="panel-heading">
            <div>
              <h2>Tiers</h2>
              <p className="help-text">{`The highest tier your $${symbol} balance reaches applies to every call made with your wallet's keys.`}</p>
            </div>
          </div>
          <ol className={styles.ladder}>
            {rows.map((t, i) => (
              <li key={t.name} className={styles.rung} data-current={current === t.name ? "" : undefined} style={{ "--i": i }}>
                <strong className={styles.rungName}>{t.name}</strong>
                <span className={styles.rungMin}>{t.min == null ? "Any balance" : `${formatTokens(t.min, 0)} ${symbol}`}</span>
                <span>{multiplierText(t.rpm_multiplier)} rate limit</span>
                <span>{t.discount_bps ? `${bpsText(t.discount_bps)} off Anyroute fees` : "Standard fees"}</span>
                {current === t.name && <span className={styles.you}>You</span>}
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="panel-heading">
        <div>
          <h2>Free credits received</h2>
          <p className="help-text">{`Credits paid to $${symbol} holders. They are added to your balance, pay for any model, and cannot be withdrawn.`}</p>
        </div>
        {credits.length > 0 && <strong className={styles.total}>{usd(view.credits_total_usd)} in total</strong>}
      </div>
      {credits.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Credited</th>
                <th>Date (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((c, i) => (
                <tr key={c.period + c.at} style={{ "--i": i }}>
                  <td className="cell-primary">
                    <strong className="mono">{c.period}</strong>
                  </td>
                  <td data-label="Credited" className="mono">
                    {usd(c.usd)}
                  </td>
                  <td data-label="Date (UTC)">{day(c.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.quiet}>{live && !signedIn ? "Sign in with your wallet to see the credits it has received." : "No free credits yet. When holders are credited, they appear here and in your balance."}</p>
      )}

      <div className="note">
        {`Tiers use the $${symbol} balance of the wallet behind your key, read from Robinhood Chain and refreshed every 5 minutes; if it cannot be read, standard limits and fees apply. A discount comes off Anyroute's own fee, never the provider's price. Prepaid calls carry no Anyroute fee, so for them the higher rate limit is the perk.`}
      </div>
    </div>
  );
}
