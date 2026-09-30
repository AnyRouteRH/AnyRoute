"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import * as wallet from "../lib/wallet";
import { STEPS as DEPOSIT_STEPS, creditEstimate, formatUsd, rateView } from "../lib/anyr-pay";
import { LINKABLE, MIXES, NOT_HIDDEN, NOT_LINKABLE, PurseFlow, anyrTerms, chainFromStatus, issuingKeys, usdgTerms } from "../lib/purse";
import { picoToUsdText } from "../lib/purse-file";
import { openPurse } from "../lib/purse-store";
import { Button, CopyButton } from "./UI";
import { ANYR_CA } from "./ContractAddress";
import styles from "./PrivatePurse.module.css";

/**
 * "Private tokens": the whole flow runs in this browser (lib/purse.js has the steps, lib/blind-rsa.js the blinding,
 * lib/purse-store.js what is kept where). Every request is relative, so the page works the same at the router's onion
 * address. The router does the money: this page adds no server logic.
 */

const STEPS = ["One-time key", "Pay", "Credit", "Buy tokens", "Keep them", "Discard the key"];
const AT_STEP = { choose: 0, keyed: 1, paying: 1, waiting: 2, funded: 3, buying: 3, minted: 4, discarded: 6 };
const MIX_LABEL = { balanced: "Mixed (recommended)", small: "Small first", medium: "Medium first", large: "Large first" };

const day = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const usd = (pico) => "$" + picoToUsdText(BigInt(pico));

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const quiet = (promise) => promise.catch(() => undefined); // the flow keeps the reason in its state

function CopyRecovery({ flow, method }) {
  const [state, setState] = useState("");
  if (method === "anyr")
    return (
      <div className={styles.recovery}>
        <p>
          <strong>If you close this tab before the tokens exist, nothing is lost.</strong> The $ANYR credit sits on your wallet’s account, not on this tab’s key. Sign in with the same wallet on the dashboard to reach it.
        </p>
      </div>
    );
  return (
    <div className={styles.recovery}>
      <p>
        <strong>Until your tokens exist, the one-time key is the only way back to money you send to it.</strong> It lives only in this tab. If you might close the tab first, copy the recovery key and keep it somewhere safe; you can paste it into the dashboard
        to see the balance or withdraw it. The page never shows the key on screen.
      </p>
      <button
        type="button"
        className="text-button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(flow.recoveryKey());
            setState("Copied");
          } catch {
            setState("Your browser did not allow copying");
          }
          setTimeout(() => setState(""), 2500);
        }}
      >
        {state || "Copy recovery key"}
      </button>
    </div>
  );
}

function Track({ deposit }) {
  if (!deposit) return null;
  return (
    <div className={styles.track} data-tone={deposit.tone}>
      <strong>
        {deposit.amount} {deposit.symbol} · {deposit.label}
      </strong>
      <ol aria-label="Progress">
        {DEPOSIT_STEPS.map((name, i) => (
          <li key={name} data-done={i < deposit.step ? "" : undefined} data-current={i === deposit.step && deposit.step < 4 ? "" : undefined}>
            {name}
          </li>
        ))}
      </ol>
      <p>{deposit.detail}</p>
    </div>
  );
}

/** The rate and escrow address for $ANYR, read while that method is chosen. */
function useAnyrRate(active) {
  const [rate, setRate] = useState(undefined);
  const [escrow, setEscrow] = useState(null);
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    let timer;
    const load = async () => {
      try {
        const [p, e] = await Promise.all([api("/api/v1/escrow/anyr/price"), api("/api/v1/escrow")]);
        if (alive) {
          setRate(p.data);
          setEscrow(e.data);
        }
      } catch {
        if (alive) setRate((r) => r ?? { enabled: true, available: false, symbol: "ANYR", reason: { code: "source_unreachable", message: "The router could not be reached, so the current rate is unknown." } });
      }
      if (alive) timer = setTimeout(load, 15_000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [active]);
  return { rate, escrow };
}

export default function PrivatePurse() {
  const [flow] = useState(() => new PurseFlow({ api, wallet, openPurse: () => openPurse(), officialAnyr: ANYR_CA }));
  const snap = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  const { state, info, progress, busy, summary } = snap;
  const [hasWallet, setHasWallet] = useState(false);
  const [method, setMethod] = useState("usdg");
  const [amount, setAmount] = useState("5");
  const [anyrAmount, setAnyrAmount] = useState("");
  const [mix, setMix] = useState("balanced");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setHasWallet(wallet.hasWallet());
    quiet(flow.init());
  }, [flow]);

  // While the payment is on its way, look for the credit.
  useEffect(() => {
    if (state.phase !== "waiting") return undefined;
    const stop = new AbortController();
    quiet(flow.waitForCredit({ signal: stop.signal }));
    return () => stop.abort();
  }, [state.phase, flow]);

  const anyr = info.status?.escrow?.anyr || null;
  const chain = chainFromStatus(info.status);
  const { rate: anyrPrice, escrow } = useAnyrRate(state.method === "anyr" && state.phase === "keyed");
  const rate = rateView(anyrPrice);
  const estimate = anyrAmount.trim() && anyr ? creditEstimate({ amountText: anyrAmount, decimals: anyr.decimals, rate: rate.rate, limit: anyr.max_usd_per_deposit ?? null }) : null;

  const plan = useMemo(() => (["funded", "buying"].includes(state.phase) && info.directory ? flow.planFor(mix) : null), [flow, state.phase, state.spendablePico, mix, info.directory]);
  const active = state.phase === "funded" ? AT_STEP.funded : AT_STEP[state.phase];
  const expires = plan?.lines.length ? day(plan.lines.map((l) => l.key.redeem_until).sort()[0]) : null;
  const tokenFile = () => flow.tokenFile();
  const act = (fn) => quiet(Promise.resolve().then(fn));
  const disabled = !!busy;
  const unlinkable = info.status?.lanes?.unlinkable;
  const onion = info.status?.onion?.url || null;

  return (
    <div className={styles.stack}>
      {info.blind === "loading" && <p className={styles.help} role="status">Reading what this router offers…</p>}
      {info.blind === "off" && <div className="note">This router does not issue blind tokens, so this page cannot buy any here.</div>}
      {info.blind === "closed" && <div className="note">The router has no token size open for sale right now. Try again in a few minutes.</div>}
      {info.blind === "error" && <div className="note">The router’s token keys could not be read. Check your connection and reload.</div>}

      <ol className={styles.steps} aria-label="Steps">
        {STEPS.map((name, i) => (
          <li key={name} data-done={i < active ? "" : undefined} data-current={i === active && state.phase !== "discarded" ? "" : undefined} aria-current={i === active && state.phase !== "discarded" ? "step" : undefined}>
            <span>{i + 1}</span>
            {name}
          </li>
        ))}
      </ol>

      {state.error && (
        <div className="error" role="alert">
          {state.error}
        </div>
      )}
      {info.storage === "none" && (
        <div className="note" role="status">
          This browser will not store tokens here ({info.storageError}). You can still buy them: the page keeps them in memory and asks you to save the token file before it lets the key go.
        </div>
      )}
      {info.sessionKept === false && state.phase !== "choose" && state.phase !== "discarded" && (
        <div className="note" role="status">
          This browser would not keep the one-time key for this tab, so reloading or closing the tab loses it. Do not close this tab until your tokens are saved, and copy the recovery key if you pay from a wallet app.
        </div>
      )}

      {state.phase === "choose" && (
        <section className={styles.panel} aria-labelledby="pt-choose">
          <h2 id="pt-choose">1 · Make a one-time key and pick how you pay</h2>
          <p className={styles.lead}>
            The key is made here, needs no account, and lives only in this tab. It receives your payment, the page turns the credit into blind tokens, and then the key is switched off and wiped.
          </p>
          <div className={styles.choices} role="radiogroup" aria-label="Payment method">
            <label className={styles.choice} data-active={method === "usdg" ? "" : undefined}>
              <input type="radio" name="method" value="usdg" checked={method === "usdg"} onChange={() => setMethod("usdg")} />
              <strong>USDG</strong>
              <span>{usdgTerms()}</span>
            </label>
            {anyr && (
              <label className={styles.choice} data-active={method === "anyr" ? "" : undefined}>
                <input type="radio" name="method" value="anyr" checked={method === "anyr"} onChange={() => setMethod("anyr")} />
                <strong>${anyr.symbol}</strong>
                <span>{anyrTerms(anyr)}</span>
              </label>
            )}
          </div>
          {method === "anyr" && (
            <p className={styles.help}>Paying with ${anyr?.symbol} asks your wallet for one signature to make a key on your wallet’s account. The key is switched off when the tokens are safe; the account and anything else on it stay yours.</p>
          )}
          <div className="button-row">
            <Button disabled={disabled || info.blind !== "available" || (method === "anyr" && !hasWallet)} onClick={() => act(() => flow.begin(method))}>
              {busy === "key" ? "Creating the key…" : method === "anyr" ? "Sign in with my wallet" : "Create the one-time key"}
            </Button>
          </div>
          {method === "anyr" && !hasWallet && <p className={styles.help}>No browser wallet was found. Pay with USDG instead: you can send it from any wallet app.</p>}
        </section>
      )}

      {(state.phase === "keyed" || state.phase === "paying") && state.method === "usdg" && (
        <section className={styles.panel} aria-labelledby="pt-pay">
          <h2 id="pt-pay">2 · Pay the key with USDG</h2>
          <p className={styles.lead}>
            {usdgTerms()} The deposit is a public transaction from your wallet to this key’s hash on {chain.name}.
          </p>
          <div className="field">
            <label htmlFor="pt-usdg">Amount / USDG</label>
            <input id="pt-usdg" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={disabled} />
          </div>
          <div className="button-row">
            <Button disabled={disabled || !hasWallet} onClick={() => act(() => flow.payUsdg(amount))}>
              {busy === "pay" ? "Waiting for your wallet…" : hasWallet ? "Pay with my wallet" : "No browser wallet found"}
            </Button>
            <Button
              secondary
              disabled={disabled || !/^\d+(\.\d{1,6})?$/.test(amount.trim()) || Number(amount) <= 0}
              onClick={() => act(async () => flow.markSent(Number(amount.trim())))}
            >
              I sent it from another wallet
            </Button>
            <button type="button" className="text-button" disabled={disabled} onClick={() => act(() => flow.cancel())}>
              Cancel and discard the key
            </button>
          </div>
          {busy === "pay" && progress.message && <p className={styles.help} role="status">{progress.message}</p>}
          <dl className={styles.facts}>
            <div>
              <dt>Key hash to pay</dt>
              <dd>
                {flow.deposit?.key_hash} <CopyButton text={flow.deposit?.key_hash || ""} label="Copy" />
              </dd>
            </div>
            <div>
              <dt>Credits contract</dt>
              <dd>{flow.deposit?.credits_contract || "Not configured on this router"}</dd>
            </div>
            <div>
              <dt>USDG contract</dt>
              <dd>{flow.deposit?.token}</dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>
                {chain.name} ({chain.id})
              </dd>
            </div>
          </dl>
          <p className={styles.help}>From a wallet app: approve USDG to the Credits contract, then call deposit(keyHash, amount) with the key hash above.</p>
          <CopyRecovery flow={flow} method={state.method} />
        </section>
      )}

      {(state.phase === "keyed" || state.phase === "paying") && state.method === "anyr" && (
        <section className={styles.panel} aria-labelledby="pt-pay">
          <h2 id="pt-pay">2 · Pay ${anyr?.symbol} to the escrow</h2>
          <p className={styles.lead}>
            {anyrTerms(anyr)} Your wallet builds and signs the transfer; the tokens stay in escrow.
          </p>
          <section className={styles.rate} data-state={rate.state} aria-live="polite" aria-label="Current rate">
            <span className="eyebrow">{rate.eyebrow}</span>
            <p>{rate.headline}</p>
            {rate.detail && <small>{rate.detail}</small>}
          </section>
          <div className="field">
            <label htmlFor="pt-anyr">{`Amount / ${anyr?.symbol}`}</label>
            <input id="pt-anyr" inputMode="decimal" autoComplete="off" placeholder="0" value={anyrAmount} onChange={(e) => setAnyrAmount(e.target.value)} disabled={disabled} />
          </div>
          {estimate && !estimate.ok && <p className={styles.warn}>{estimate.error}</p>}
          {estimate?.ok && !estimate.capped && (
            <p className={styles.receive} aria-live="polite">
              {estimate.credit != null ? (
                <>
                  You receive ≈ <strong>{formatUsd(estimate.credit)}</strong> in credit, which the page turns into tokens.
                </>
              ) : (
                "Credited at the price in effect when the transfer clears."
              )}
            </p>
          )}
          {estimate?.ok && estimate.capped && (
            <p className={styles.warn} role="alert">
              That is above the {formatUsd(anyr.max_usd_per_deposit)} credited per deposit. Send at most about {estimate.maxTokens?.toLocaleString("en-US")} {anyr.symbol}; anything above is held for the operator to review.
            </p>
          )}
          <dl className={styles.facts}>
            <div>
              <dt>Send from</dt>
              <dd>{flow.wallet}</dd>
            </div>
            <div>
              <dt>To (escrow)</dt>
              <dd>{escrow?.address || "…"}</dd>
            </div>
            <div>
              <dt>{anyr?.symbol} contract</dt>
              <dd>{anyr?.address}</dd>
            </div>
            <div>
              <dt>Haircut</dt>
              <dd>{anyr?.haircut_bps ? `${anyr.haircut_bps / 100}%` : "none"}</dd>
            </div>
          </dl>
          <div className="button-row">
            <Button disabled={disabled || rate.state !== "live" || !estimate?.ok || estimate.capped} onClick={() => act(() => flow.payAnyr(anyrAmount))}>
              {busy === "pay" ? "Waiting for your wallet…" : `Send ${anyr?.symbol} with my wallet`}
            </Button>
            <button type="button" className="text-button" disabled={disabled} onClick={() => act(() => flow.cancel())}>
              Cancel and discard the key
            </button>
          </div>
          {busy === "pay" && progress.message && <p className={styles.help} role="status">{progress.message}</p>}
          <CopyRecovery flow={flow} method={state.method} />
        </section>
      )}

      {state.phase === "waiting" && (
        <section className={styles.panel} aria-labelledby="pt-wait">
          <h2 id="pt-wait">3 · Waiting for the credit</h2>
          <p className={styles.lead}>
            {state.method === "anyr"
              ? "The transfer is credited once the chain finalizes it and the router has a steady price. You can leave this tab open; it checks on its own."
              : "The deposit is credited to the key once the router sees it on the chain. You can leave this tab open; it checks on its own."}
          </p>
          <p className={styles.status} role="status" aria-live="polite">
            {progress.message || "Checking…"}
            {progress.available != null && Number(progress.available) > 0 && <> On the key so far: ${progress.available}.</>}
          </p>
          <Track deposit={progress.deposit} />
          <div className="button-row">
            {state.method === "usdg" && progress.available != null && Number(progress.available) > 0 && (
              <Button secondary disabled={disabled} onClick={() => act(() => flow.useArrivedBalance())}>
                Use the ${progress.available} that has arrived
              </Button>
            )}
          </div>
          <CopyRecovery flow={flow} method={state.method} />
        </section>
      )}

      {(state.phase === "funded" || state.phase === "buying") && plan && (
        <section className={styles.panel} aria-labelledby="pt-buy">
          <h2 id="pt-buy">4 · Turn the credit into blind tokens</h2>
          <p className={styles.lead}>
            {state.method === "anyr" ? "Newly credited" : "On the key"}: <strong>{usd(state.spendablePico)}</strong>. The page blinds each token here, the router signs it without seeing it, and the page unblinds the result.
          </p>
          <div className="field">
            <label htmlFor="pt-mix">Token sizes</label>
            <select id="pt-mix" value={mix} onChange={(e) => setMix(e.target.value)} disabled={disabled}>
              {MIXES.map((m) => (
                <option key={m} value={m}>
                  {MIX_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          {plan.lines.length ? (
            <div className={styles.planWrap}>
            <table className={styles.plan}>
              <caption>What this buys</caption>
              <thead>
                <tr>
                  <th scope="col">Tokens</th>
                  <th scope="col">Each covers a call up to</th>
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((l) => (
                  <tr key={l.key.denomination}>
                    <td>{l.count.toLocaleString("en-US")}</td>
                    <td>{usd(l.valuePico)}</td>
                    <td>{usd(BigInt(l.count) * l.valuePico)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    {plan.tokenCount.toLocaleString("en-US")} tokens in {plan.requests} request{plan.requests === 1 ? "" : "s"}
                  </th>
                  <td>{usd(plan.costPico)}</td>
                </tr>
              </tfoot>
            </table>
            </div>
          ) : (
            <p className={styles.warn}>The smallest token costs more than what is on the key, so nothing can be bought. Pay a little more, or use the balance another way.</p>
          )}
          {plan.leftoverPico > 0n && plan.lines.length > 0 && (
            <p className={styles.help}>
              Left over: {usd(plan.leftoverPico)}, less than the smallest token. It is given up when the key is discarded.
            </p>
          )}
          <ul className={styles.notes}>
            <li>Each token pays for one call, up to its value. The unused part of a token is not returned, so small tokens waste least.</li>
            {expires && <li>Tokens stop working on {expires}. Spend them before then; the router cannot replace a lost or expired token.</li>}
            <li>The router limits purchases per minute and per day, so a large purchase takes a few minutes. Keep this tab open.</li>
          </ul>
          {busy === "mint" && (
            <div className={styles.meter} role="status" aria-live="polite">
              <progress max={Math.max(progress.target, 1)} value={progress.minted} />
              <span>
                {progress.minted.toLocaleString("en-US")} of {progress.target.toLocaleString("en-US")} tokens
              </span>
              {progress.message && <small>{progress.message}</small>}
            </div>
          )}
          <div className="button-row">
            <Button disabled={disabled || !plan.lines.length} onClick={() => act(() => flow.mint(mix))}>
              {busy === "mint" ? "Buying…" : state.mintedCount ? "Buy the rest" : "Buy the tokens"}
            </Button>
          </div>
          <CopyRecovery flow={flow} method={state.method} />
        </section>
      )}

      {state.phase === "minted" && (
        <section className={styles.panel} aria-labelledby="pt-keep">
          <h2 id="pt-keep">5 · Save your tokens</h2>
          <p className={styles.lead}>
            You have {summary.count.toLocaleString("en-US")} tokens worth ${summary.valueUsd}. This browser could not store them, so they exist only in this tab until you save the token file. The one-time key is kept until then, and discarded as soon as the file is saved.
          </p>
          <div className="button-row">
            <Button
              onClick={() =>
                act(async () => {
                  const f = tokenFile();
                  download(f.name, f.text);
                  await flow.fileSaved();
                })
              }
            >
              Download token file
            </Button>
          </div>
        </section>
      )}

      {state.phase === "discarded" && (
        <section className={styles.panel} aria-labelledby="pt-done">
          <h2 id="pt-done">{state.mintedCount ? "Done: the key is gone" : "The key is gone"}</h2>
          {state.mintedCount > 0 && (
            <p className={styles.lead}>
              You hold {summary.count.toLocaleString("en-US")} tokens worth ${summary.valueUsd}
              {summary.firstExpiry ? `, the first stopping on ${day(summary.firstExpiry)}` : ""}. {info.storage === "browser" ? "They are stored in this browser." : "They are in the file you saved."}
            </p>
          )}
          <ul className={styles.report}>
            <li data-ok={state.discarded?.memory ? "" : undefined}>The copy of the key held in this page was overwritten and dropped.</li>
            <li data-ok={state.discarded?.stored ? "" : undefined}>{state.discarded?.stored ? "The copy kept for this tab was removed." : "The copy kept for this tab could not be removed. Close this tab to clear it."}</li>
            {state.discarded?.remote === true && <li data-ok="">The key was switched off at the router, so it can no longer be used.</li>}
            {state.discarded?.remote === false && (
              <li>The router could not be reached to switch the key off. It is gone from this page, and nothing else holds it. Sign in on the dashboard to disable “One-time key for private tokens” if you want it dead now.</li>
            )}
          </ul>
          <div className="button-row">
            {summary.count > 0 && (
              <Button
                onClick={() => {
                  const f = tokenFile();
                  download(f.name, f.text);
                }}
              >
                Download token file
              </Button>
            )}
            <Button secondary onClick={() => flow.startOver()}>
              Buy more
            </Button>
          </div>
        </section>
      )}

      <section className={styles.panel} aria-labelledby="pt-held">
        <h2 id="pt-held">Your tokens</h2>
        {summary.count > 0 ? (
          <>
            <p className={styles.lead}>
              {summary.count.toLocaleString("en-US")} tokens worth ${summary.valueUsd}.
              {summary.firstExpiry ? ` The first stops working on ${day(summary.firstExpiry)}.` : ""}
            </p>
            <ul className={styles.sizes}>
              {summary.sizes.map((s) => (
                <li key={s.valueUsd}>
                  {s.count.toLocaleString("en-US")} × ${s.valueUsd}
                </li>
              ))}
            </ul>
            <p className={styles.help}>
              {info.storage === "browser"
                ? "Stored in this browser only. Clearing site data deletes them, so keep the token file as your backup. Anyone who has the file can spend the tokens. If you already keep tokens in ~/.anyroute/tokens.json, merge the download into that file instead of replacing it; the documentation shows how."
                : "This browser is not storing them: the token file is the only copy."}
            </p>
            <div className="button-row">
              <Button
                secondary
                onClick={() => {
                  const f = tokenFile();
                  download(f.name, f.text);
                }}
              >
                Download token file
              </Button>
              {info.storage === "browser" &&
                (confirmDelete ? (
                  <>
                    <button type="button" className="text-button" onClick={() => act(async () => { await flow.deleteTokens(info.tokens.map((t) => t.token)); setConfirmDelete(false); })}>
                      Yes, remove them from this browser
                    </button>
                    <button type="button" className="text-button" onClick={() => setConfirmDelete(false)}>
                      Keep them
                    </button>
                  </>
                ) : (
                  <button type="button" className="text-button" onClick={() => setConfirmDelete(true)}>
                    Remove from this browser
                  </button>
                ))}
            </div>
          </>
        ) : (
          <p className={styles.lead}>None yet. Tokens you buy here are kept in this browser and can be saved as a token file.</p>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="pt-link">
        <h2 id="pt-link">What is linkable, and what is not</h2>
        <div className={styles.columns}>
          <div>
            <h3>Can be linked to you</h3>
            <ul>
              {LINKABLE.map(([head, text]) => (
                <li key={head}>
                  <strong>{head}</strong> {text}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Cannot be linked to you</h3>
            <ul>
              {NOT_LINKABLE.map(([head, text]) => (
                <li key={head}>
                  <strong>{head}</strong> {text}
                </li>
              ))}
            </ul>
            <h3>What tokens do not hide</h3>
            <ul>
              {NOT_HIDDEN.map(([head, text]) => (
                <li key={head}>
                  <strong>{head}</strong> {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="pt-spend">
        <h2 id="pt-spend">Spending them</h2>
        <p className={styles.lead}>
          {unlinkable?.available
            ? `This router serves the unlinkable lane over: ${(unlinkable.via || []).join(", ") || "its configured paths"}. `
            : "This router does not serve the unlinkable lane right now, so tokens cannot be spent here yet. "}
          A token goes in the Authorization header as <code>PrivateToken token=&lt;token&gt;</code>, with the lane named in <code>X-Anyroute-Lane: unlinkable</code>. The token file format and a worked example are in{" "}
          <a className="inline-link" href="/docs/#private-tokens">
            the developer documentation
          </a>
          .
        </p>
        {onion && (
          <p className={styles.help}>
            This router’s onion address is <code>{onion.replace(/^http:\/\//, "")}</code>. This page works there too: every request it makes is relative to the address you opened it from.
          </p>
        )}
      </section>
    </div>
  );
}
