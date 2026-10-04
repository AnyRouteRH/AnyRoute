"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { connect, connectedAccount, ensureChain, hasWallet, sendTransactions, shortAddress, tokenBalance } from "../lib/wallet";
import { qrMatrix, qrPath } from "../lib/qr";
import { ANYR_ATTESTED_LINE, STEPS, creditEstimate, depositView, depositsOf, erc20TransferData, formatUnits, formatUsd, newlyCredited, pollInterval, rateView, stageOf } from "../lib/anyr-pay";
import { Button, CopyButton, Modal } from "./UI";
import { ANYR_CA } from "./ContractAddress";
import styles from "./PayAnyr.module.css";

/**
 * "Pay with $ANYR": the live rate the router credits at (GET /api/v1/escrow/anyr/price), the escrow address with copy
 * and a QR code, a one-click transfer the user signs in their own wallet, and live tracking of the deposit through
 * finality to a credit (GET /api/v1/escrow/deposits). The page never holds a key: the wallet builds, shows and signs
 * the transfer.
 *
 * Props: escrow (GET /api/v1/escrow), stock (GET /api/v1/escrow/deposits), chain ({id,name,rpc,explorer}), apiKey,
 * balance (available credits, USD), onCredited() (refresh the workspace), onClose().
 */

function QrCode({ text }) {
  const code = useMemo(() => {
    try {
      const m = qrMatrix(text);
      return { n: m.size, d: qrPath(m) };
    } catch {
      return null;
    }
  }, [text]);
  if (!code) return null;
  return (
    <div className={styles.qr}>
      <svg viewBox={`-4 -4 ${code.n + 8} ${code.n + 8}`} role="img" aria-label={`QR code of the escrow address ${text}`} shapeRendering="crispEdges">
        <rect x="-4" y="-4" width={code.n + 8} height={code.n + 8} fill="#fff" />
        <path d={code.d} fill="#0b0c0b" />
      </svg>
    </div>
  );
}

const safeExplorer = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u.replace(/\/$/, "") : null);

export default function PayAnyrDialog({ escrow: initialEscrow, stock, chain, apiKey, balance, onCredited, onClose }) {
  const [escrow, setEscrow] = useState(initialEscrow);
  const [price, setPrice] = useState(undefined); // undefined: loading; otherwise GET /api/v1/escrow/anyr/price
  const [deposits, setDeposits] = useState(stock?.deposits || []);
  const [available, setAvailable] = useState(balance);
  const [amount, setAmount] = useState("");
  const [held, setHeld] = useState(false); // the user accepts sending while there is no price
  const [walletBalance, setWalletBalance] = useState(null);
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const alive = useRef(true);
  const depositsRef = useRef(deposits);
  const wake = useRef(null);
  depositsRef.current = deposits;

  const wallet = stock?.wallet || "";
  const anyr = escrow?.anyr || null;
  const token = escrow?.tokens?.find((t) => t.address === anyr?.address) || null;
  const decimals = anyr?.decimals ?? 18;
  const symbol = anyr?.symbol || "ANYR";
  const explorer = safeExplorer(chain?.explorer || escrow?.explorer);
  const rate = rateView(price);
  const estimate = amount.trim() ? creditEstimate({ amountText: amount, decimals, rate: rate.rate, limit: anyr?.max_usd_per_deposit ?? null }) : null;
  const mine = depositsOf(deposits, symbol, 5);
  const official = !anyr || anyr.address.toLowerCase() === ANYR_CA.toLowerCase();
  const blocked = !anyr || !official || !wallet || busy || !estimate?.ok || estimate.capped || (rate.state !== "live" && !held);

  // The rate: every 15 s while the dialog is open (the router caches its reading for 30 s).
  useEffect(() => {
    alive.current = true;
    let timer;
    const load = async () => {
      try {
        const r = await api("/api/v1/escrow/anyr/price");
        if (alive.current) setPrice(r.data);
      } catch {
        if (alive.current) setPrice((p) => p ?? { enabled: true, available: false, symbol, reason: { code: "source_unreachable", message: "The Anyroute API could not be reached, so the current rate is unknown." } });
      }
      if (alive.current) timer = setTimeout(load, 15_000);
    };
    load();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [symbol]);

  // Deposits, finality and the credit balance: every 5 s while a deposit is on its way, every 20 s otherwise.
  // `wake` ends the current wait early (right after a transfer is sent).
  useEffect(() => {
    if (!apiKey || !wallet) return undefined;
    let stopped = false;
    let sleep;
    const load = async () => {
      try {
        const [d, e, c] = await Promise.all([api("/api/v1/escrow/deposits", { key: apiKey }), api("/api/v1/escrow"), api("/api/v1/credits", { key: apiKey })]);
        if (stopped) return;
        const before = depositsRef.current;
        const next = d.data?.deposits || [];
        const fresh = newlyCredited(before, next).filter((x) => x.symbol === symbol);
        setDeposits(next);
        if (e.data?.enabled) setEscrow(e.data);
        if (c.data?.available != null) setAvailable(Number(c.data.available));
        if (fresh.length && before.length) {
          setStep("");
          setDone(`${fresh.map((x) => `${x.amount} ${x.symbol}`).join(", ")} credited: ${formatUsd(fresh.reduce((n, x) => n + (x.credited_usd || 0), 0))} added to your balance.`);
          onCredited?.();
        }
      } catch {
        /* keep the last known state; the next pass tries again */
      }
    };
    (async () => {
      await load();
      while (!stopped) {
        await new Promise((resolve) => {
          sleep = setTimeout(resolve, pollInterval(depositsRef.current));
          wake.current = () => {
            clearTimeout(sleep);
            resolve();
          };
        });
        if (stopped) return;
        await load();
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(sleep);
      wake.current?.();
      wake.current = null;
    };
  }, [apiKey, wallet, symbol]);

  // The wallet's own balance, when the wallet has already shared its account with this site.
  useEffect(() => {
    if (!wallet || !anyr || !hasWallet()) return;
    let live = true;
    (async () => {
      const account = await connectedAccount();
      if (!account || account.toLowerCase() !== wallet.toLowerCase()) return;
      const raw = await tokenBalance(account, anyr.address);
      if (live && raw != null) setWalletBalance(raw);
    })();
    return () => {
      live = false;
    };
  }, [wallet, anyr?.address]);

  async function send() {
    setError("");
    setDone("");
    if (!estimate?.ok) return setError(estimate?.error || "Enter an amount.");
    setBusy(true);
    try {
      const from = await connect();
      if (from.toLowerCase() !== wallet.toLowerCase()) throw new Error(`Switch your wallet to ${shortAddress(wallet)}, the wallet you signed in with. Tokens sent from another wallet are credited to that wallet.`);
      await ensureChain(chain);
      const data = erc20TransferData(escrow.address, estimate.raw);
      await sendTransactions(from, [{ to: anyr.address, data, description: `Send ${amount.trim()} ${symbol} to the escrow address` }], setStep);
      setAmount("");
      // Look again soon and a few times after: the transfer shows up as "Waiting for finality" within seconds.
      for (const ms of [500, 3000, 8000]) setTimeout(() => alive.current && wake.current?.(), ms);
      setStep("Sent. Track it below: it is credited once the chain finalizes it.");
    } catch (e) {
      setStep("");
      setError(e?.code === 4001 || /user (rejected|denied)/i.test(String(e?.message)) ? "You declined the transfer in your wallet. Nothing was sent." : e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!escrow?.address || !anyr)
    return (
      <Modal title="Pay with $ANYR" onClose={onClose}>
        <p>This router does not take $ANYR payments.</p>
      </Modal>
    );

  return (
    <Modal title={`Pay with $${symbol}`} onClose={onClose}>
      <div className={styles.root}>
        <p className={styles.lede}>
          Send ${symbol} on {chain?.name || "the chain"} to the escrow address. Once the chain finalizes the transfer it becomes credits on the wallet that sent it. Your wallet builds and signs the transfer: Anyroute never holds your keys, and the tokens stay in escrow.
        </p>

        {wallet && (
          <div className={styles.balance} aria-live="polite">
            <span>Available credits</span>
            <strong>{formatUsd(available ?? 0)}</strong>
          </div>
        )}

        <section className={styles.rate} data-state={rate.state} aria-live="polite" aria-label="Current rate">
          <span className="eyebrow">{rate.eyebrow}</span>
          <p className={styles.rateHead}>{rate.headline}</p>
          {rate.detail && <p className={styles.rateDetail}>{rate.detail}</p>}
          {rate.state === "live" && (
            <ul className={styles.rateFacts}>
              {rate.perDollar && <li>$1 of credit = {rate.perDollar} {symbol}</li>}
              {rate.spot != null && <li>spot {formatUsd(rate.spot)}</li>}
              {rate.average != null && <li>average {formatUsd(rate.average)}</li>}
              {rate.swaps != null && <li>{rate.swaps.toLocaleString("en-US")} swaps · {Math.round((rate.windowSeconds || 0) / 60)} min</li>}
            </ul>
          )}
          {rate.state === "unavailable" && rate.note && <p className={styles.rateNote}>{rate.note}</p>}
        </section>

        {!official && (
          <p className={styles.official} role="alert">
            The router lists {symbol} at {shortAddress(anyr.address)}, which is not the official $ANYR contract ({shortAddress(ANYR_CA)}). Do not send anything until you have checked it.
          </p>
        )}

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {step && (
          <div className="success" role="status">
            {step}
          </div>
        )}
        {done && (
          <div className="success" role="status">
            {done}
          </div>
        )}

        {!wallet ? (
          <div className="note">Deposits are credited to the wallet that sends them. Sign out, then choose “Sign in with wallet” using the wallet you will send from; you can then send here in one click and follow the deposit.</div>
        ) : (
          <section className={styles.send} aria-label="Send">
            <h3>Send from {shortAddress(wallet)}</h3>
            <div className={styles.amountRow}>
              <div className="field">
                <label htmlFor="anyr-amount">{`Amount / ${symbol}`}</label>
                <input id="anyr-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
              </div>
              {walletBalance != null && walletBalance > 0n && (
                <button type="button" className={styles.max} onClick={() => setAmount(formatUnits(walletBalance, decimals, decimals).replaceAll(",", ""))} disabled={busy}>
                  Max {formatUnits(walletBalance, decimals, 2)}
                </button>
              )}
            </div>
            {estimate && !estimate.ok && <p className={styles.warn}>{estimate.error}</p>}
            {estimate?.ok && !estimate.capped && (
              <p className={styles.receive} aria-live="polite">
                {estimate.credit != null ? (
                  <>
                    You receive ≈ <strong>{formatUsd(estimate.credit)}</strong> in credits.
                  </>
                ) : (
                  <>Credited at the price in effect when the transfer clears.</>
                )}
              </p>
            )}
            {estimate?.ok && estimate.capped && (
              <p className={styles.warn} role="alert">
                That is above the {formatUsd(anyr.max_usd_per_deposit)} credited per deposit. Send at most about {estimate.maxTokens?.toLocaleString("en-US")} {symbol} at a time; anything above the limit is not credited automatically and is held for the operator to review.
              </p>
            )}
            {rate.state !== "live" && rate.state !== "loading" && (
              <label className={styles.check}>
                <input type="checkbox" checked={held} onChange={(e) => setHeld(e.target.checked)} disabled={busy} />
                <span>There is no price at the moment. Send anyway: the deposit waits and is credited automatically at the price in effect when it clears, up to {formatUsd(anyr.max_usd_per_deposit)}.</span>
              </label>
            )}
            <dl className={styles.facts}>
              <div>
                <dt>To (escrow)</dt>
                <dd>{escrow.address}</dd>
              </div>
              <div>
                <dt>{symbol} contract</dt>
                <dd>{anyr.address}</dd>
              </div>
            </dl>
            <div className={styles.actions}>
              <Button onClick={send} disabled={blocked}>
                {busy ? "Waiting for your wallet…" : hasWallet() ? `Send ${symbol} with wallet` : "Connect a wallet"}
              </Button>
            </div>
          </section>
        )}

        <section className={styles.where} aria-label="Escrow address">
          <h3>{wallet ? "Or send from any wallet app" : "Escrow address"}</h3>
          <div className={styles.addr}>
            <code>{escrow.address}</code>
            <div>
              <CopyButton text={escrow.address} label="Copy escrow address" />
              {explorer && (
                <>
                  {" · "}
                  <a className="text-button" href={`${explorer}/address/${escrow.address}`} target="_blank" rel="noreferrer">
                    View on explorer
                  </a>
                </>
              )}
            </div>
            <small>
              Send only {symbol} on {chain?.name || "the chain"} (chain {chain?.id ?? escrow.chain_id}). The token contract is <span className="mono">{shortAddress(anyr.address)}</span>{" "}
              <CopyButton text={anyr.address} label="Copy" />. Tokens sent from an exchange or another wallet are credited to that sender.
            </small>
          </div>
          <QrCode text={escrow.address} />
        </section>

        {wallet && (
          <section className={styles.track} aria-label="Your deposits">
            <div className={styles.trackHead}>
              <h3>Your {symbol} deposits</h3>
              <span className={styles.live}>updates every {pollInterval(deposits) / 1000} s</span>
            </div>
            {mine.length ? (
              <ul className={styles.deposits}>
                {mine.map((d) => {
                  const v = depositView(d, escrow);
                  return (
                    <li key={d.id} className={styles.deposit} data-tone={v.tone}>
                      <div className={styles.depositHead}>
                        <strong>
                          {d.amount} {d.symbol}
                        </strong>
                        <span className={styles.stage}>{v.label}</span>
                      </div>
                      <ol className={styles.steps} aria-label="Progress">
                        {STEPS.map((name, i) => (
                          <li key={name} data-done={i < v.step ? "" : undefined} data-current={i === v.step && v.step < 4 ? (v.tone === "warn" ? "warn" : v.tone === "bad" ? "bad" : "") : undefined} aria-current={i === v.step && v.step < 4 ? "step" : undefined}>
                            {name}
                          </li>
                        ))}
                      </ol>
                      <p className={styles.detail}>{v.detail}</p>
                      <span className={styles.depositMeta}>
                        {new Date(d.at).toLocaleString("en-GB")} ·{" "}
                        {explorer ? (
                          <a href={`${explorer}/tx/${d.tx_hash}`} target="_blank" rel="noreferrer">
                            {d.tx_hash.slice(0, 10)}…
                          </a>
                        ) : (
                          `${d.tx_hash.slice(0, 10)}…`
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.empty}>No {symbol} deposits from {shortAddress(wallet)} yet. A transfer appears here within seconds and is credited once the chain finalizes it.</p>
            )}
          </section>
        )}

        <p className={styles.lane}>{ANYR_ATTESTED_LINE}</p>
      </div>
    </Modal>
  );
}
