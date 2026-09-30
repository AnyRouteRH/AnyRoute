"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Code, CopyButton } from "../UI";
import { API_BASE, ApiError, api, setMode } from "../../lib/api";
import { connect, hasWallet, personalSign } from "../../lib/wallet";
import {
  ADDRESS_RE,
  GENESIS,
  INVITE_METHODS,
  OWNER_KIND,
  ROLES,
  ROLE_INFO,
  SAMPLE_TEAM_ID,
  SIGNATURE_RE,
  TTL,
  actionLabel,
  actorLabel,
  assignableRoles,
  atLeast,
  canManage,
  auditPage,
  budgetShare,
  credentialCreateOptions,
  credentialGetOptions,
  detailText,
  dispositionName,
  encodeAssertion,
  encodeRegistration,
  exportCsv,
  exportJsonl,
  extractInvite,
  formatUsd,
  hourlyRoots,
  inviteRoles,
  joinLink,
  keyRoles,
  normalizeRole,
  pageCount,
  parseBudget,
  parseExport,
  passkeyError,
  passkeysSupported,
  roleLabel,
  sampleAuditEntries,
  sampleTeam,
  sealEntries,
  shortAddr,
  shortHex,
  validateInvite,
  verifyChain,
  verifyExport,
  verifyRoots,
} from "../../lib/teams";
import routeStyles from "./SavedRoutes.module.css";
import styles from "./Teams.module.css";

/**
 * Teams workspace tab: anonymous organisations with roles, passkey and wallet members, an owner wallet or Safe, an
 * organisation budget and a hash-chained audit log. Props (from Dashboard): { live, apiKey, ws, notify, signedIn, onKey,
 * onSecret }. It also renders signed out, so an invite link (/dashboard/?join=<invite>#teams) works with no key: onKey
 * signs the dashboard in with the key a join or sign-in returns, and onSecret shows that key once.
 * live=false shows a labelled sample organisation and never calls the API.
 */

const enc = encodeURIComponent;
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never");
const message = (e) => e?.message || String(e);
const SAMPLE = "Sample only";
const PAGE = 25;
const LAST_TEAM = "anyroute-last-team";
const remember = (id) => {
  try {
    localStorage.setItem(LAST_TEAM, id);
  } catch {
    /* storage unavailable: nothing to remember */
  }
};
const recall = () => {
  try {
    return localStorage.getItem(LAST_TEAM) || "";
  } catch {
    return "";
  }
};
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Err({ children }) {
  return children ? (
    <div className="error" role="alert">
      {children}
    </div>
  ) : null;
}

function RoleSelect({ id, value, options, onChange, disabled, label }) {
  const current = normalizeRole(value) || value;
  const list = options.includes(current) ? options : [current, ...options];
  return (
    <select id={id} className={styles.roleSelect} aria-label={label} value={current} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {list.map((r) => (
        <option key={r} value={r}>
          {roleLabel(r)}
        </option>
      ))}
    </select>
  );
}

// ---------- the organisation at a glance ----------

function Facts({ team }) {
  const share = budgetShare(team);
  const people = team.principals?.length ?? 0;
  const keys = team.members?.length ?? 0;
  const role = normalizeRole(team.your_role);
  return (
    <div className={styles.facts}>
      <div className={styles.fact + " " + styles.factInk}>
        <span className="eyebrow">Your role</span>
        <strong>{roleLabel(role)}</strong>
        <span>{ROLE_INFO[role]?.summary}</span>
      </div>
      <div className={styles.fact}>
        <span className="eyebrow">Organisation budget</span>
        <strong>{team.budget_usd == null ? "None" : formatUsd(team.budget_usd)}</strong>
        {share != null && (
          <div className={styles.meter} data-level={share >= 90 ? "high" : "ok"} role="meter" aria-label="Budget given to keys" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}>
            <span style={{ width: share + "%" }} />
          </div>
        )}
        <span>
          {formatUsd(team.allocated_usd || 0)} given to keys{team.budget_usd == null ? ", no cap" : ""}
        </span>
      </div>
      <div className={styles.fact}>
        <span className="eyebrow">Members</span>
        <strong>{people}</strong>
        <span>
          {people === 1 ? "passkey or wallet member" : "passkey and wallet members"} · {keys} key{keys === 1 ? "" : "s"}
        </span>
      </div>
      <div className={styles.fact}>
        <span className="eyebrow">Audit log</span>
        <strong>{team.audit?.entries ?? 0}</strong>
        <span>
          entries · head <code className="mono">{shortHex(team.audit?.head)}</code>
        </span>
      </div>
    </div>
  );
}

function BindOwnerDialog({ team, apiKey, onClose, onBound }) {
  const [address, setAddress] = useState(team.owner?.address || "");
  const [challenge, setChallenge] = useState(null);
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const addr = address.trim();
  async function run(label, fn) {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function bind(sig) {
    if (!SIGNATURE_RE.test(sig)) throw new Error("A signature is 0x followed by hex characters.");
    const r = await api(`/api/v1/teams/${enc(team.id)}/owner`, { key: apiKey, method: "POST", body: { address: addr, nonce: challenge.nonce ?? challenge.challenge_id, signature: sig } });
    await onBound(r.data);
  }
  return (
    <Modal title="Bind an owner wallet or Safe" onClose={onClose}>
      <p>
        The owner can be a wallet or a smart account such as a Safe. A wallet’s signature is checked by recovering its address. A Safe’s is checked on chain with EIP-1271: its isValidSignature must return 0x1626ba7e, so the Safe’s own owners and threshold decide. Once bound, it signs in to this organisation as owner.
      </p>
      <Err>{error}</Err>
      <div className="field">
        <label htmlFor="owner-address">Wallet or Safe address</label>
        <input id="owner-address" className="mono" value={address} disabled={!!challenge || !!busy} autoComplete="off" spellCheck={false} placeholder="0x…" onChange={(e) => setAddress(e.target.value)} />
      </div>
      {!challenge ? (
        <div className="button-row modal-actions">
          <Button
            disabled={!!busy}
            onClick={() =>
              run("challenge", async () => {
                if (!ADDRESS_RE.test(addr)) throw new Error("Enter a 0x address of 40 hex characters.");
                const r = await api(`/api/v1/teams/${enc(team.id)}/owner/challenge`, { key: apiKey, method: "POST", body: { address: addr } });
                setChallenge(r.data);
              })
            }
          >
            {busy === "challenge" ? "Asking the router…" : "Get the message to sign"}
          </Button>
          {hasWallet() && (
            <Button secondary disabled={!!busy} onClick={() => run("connect", async () => setAddress(await connect()))}>
              Use my wallet’s address
            </Button>
          )}
        </div>
      ) : (
        <>
          <Code label={`Message to sign · expires ${when(challenge.expires_at)}`}>{challenge.message}</Code>
          {hasWallet() && (
            <div className="button-row">
              <Button disabled={!!busy} onClick={() => run("sign", async () => bind(await personalSign(addr, challenge.message)))}>
                {busy === "sign" ? "Waiting for the signature…" : "Sign with my wallet"}
              </Button>
            </div>
          )}
          <div className={"field " + styles.gap}>
            <label htmlFor="owner-signature">Or paste a signature</label>
            <textarea id="owner-signature" className={styles.sig} spellCheck={false} value={signature} placeholder="0x…" onChange={(e) => setSignature(e.target.value)} aria-describedby="owner-signature-hint" />
            <small className={routeStyles.hint} id="owner-signature-hint">
              For a Safe, have its owners sign this exact text as a message in the Safe app, then paste the signature here.
            </small>
          </div>
          <div className="button-row modal-actions">
            <Button disabled={!!busy || !signature.trim()} onClick={() => run("bind", () => bind(signature.trim()))}>
              {busy === "bind" ? "Checking the signature…" : "Bind with this signature"}
            </Button>
            <Button secondary onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function OwnerBlock({ team, live, apiKey, notify, onChanged }) {
  const [binding, setBinding] = useState(false);
  const o = team.owner || {};
  const isOwner = normalizeRole(team.your_role) === "owner";
  return (
    <section className={styles.block} aria-labelledby="team-owner-title">
      <span className="eyebrow">Owner</span>
      <h3 id="team-owner-title">{o.address ? shortAddr(o.address) : "The owning account"}</h3>
      <dl className="detail-list">
        <div>
          <dt>Kind</dt>
          <dd>{OWNER_KIND[o.kind] || OWNER_KIND.account}</dd>
        </div>
        {o.address && (
          <div>
            <dt>Address</dt>
            <dd className="mono">{o.address}</dd>
          </div>
        )}
        <div>
          <dt>Verified</dt>
          <dd>{o.verified_at ? when(o.verified_at) : "No wallet bound"}</dd>
        </div>
      </dl>
      <p className="help-text">
        {o.kind === "contract"
          ? "A smart account: the router checked its signature on chain (EIP-1271), so the Safe’s owners and threshold decide who acts as owner."
          : o.kind === "eoa"
            ? "A wallet: it signs in to this organisation as owner."
            : "Bind a wallet or a Safe so the owner is a key you hold, not only the account’s management key."}
      </p>
      {isOwner &&
        (live ? (
          <Button secondary onClick={() => setBinding(true)}>
            {o.address ? "Bind another wallet or Safe" : "Bind a wallet or Safe"}
          </Button>
        ) : (
          <Button secondary disabled title={SAMPLE}>
            Bind a wallet or Safe
          </Button>
        ))}
      {binding && (
        <BindOwnerDialog
          team={team}
          apiKey={apiKey}
          onClose={() => setBinding(false)}
          onBound={async (t) => {
            setBinding(false);
            await onChanged();
            notify?.(`Bound ${t?.owner?.address || "the wallet"} as the owner of ${team.name}.`);
          }}
        />
      )}
    </section>
  );
}

function SettingsForm({ team, live, apiKey, notify, onChanged }) {
  const [name, setName] = useState(team.name);
  const [budget, setBudget] = useState(team.budget_usd == null ? "" : String(team.budget_usd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setName(team.name);
    setBudget(team.budget_usd == null ? "" : String(team.budget_usd));
  }, [team.id, team.name, team.budget_usd]);
  return (
    <form
      className={styles.block}
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        const b = parseBudget(budget);
        if (!b.ok) return setError(b.error);
        if (!name.trim()) return setError("An organisation needs a name.");
        const body = {};
        if (name.trim() !== team.name) body.name = name.trim();
        if (b.value !== (team.budget_usd ?? null)) body.budget_usd = b.value;
        if (!Object.keys(body).length) return setError("Nothing changed.");
        setBusy(true);
        try {
          await api(`/api/v1/teams/${enc(team.id)}`, { key: apiKey, method: "PATCH", body });
          await onChanged();
          notify?.("budget_usd" in body ? (body.budget_usd == null ? `Removed the budget of ${team.name}.` : `Set the budget of ${body.name || team.name} to ${formatUsd(body.budget_usd)}.`) : `Renamed the organisation to ${body.name}.`);
        } catch (err) {
          setError(message(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="eyebrow">Settings · admin</span>
      <h3>Name and budget</h3>
      <Err>{error}</Err>
      <fieldset className={styles.plain} disabled={!live || busy} title={live ? undefined : SAMPLE}>
        <div className="field">
          <label htmlFor="team-name">Name</label>
          <input id="team-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="team-budget">Organisation budget / USD</label>
          <input id="team-budget" type="number" inputMode="decimal" min="0" step="any" placeholder="No budget" value={budget} onChange={(e) => setBudget(e.target.value)} aria-describedby="team-budget-hint" />
          <small className={routeStyles.hint} id="team-budget-hint">
            Caps the sum of the limits of the keys in this organisation. Keys hold {formatUsd(team.allocated_usd || 0)} now. With a budget, every new key needs a limit.
          </small>
        </div>
        <Button type="submit">{busy ? "Saving…" : "Save"}</Button>
      </fieldset>
    </form>
  );
}

function RoleGuide({ yourRole }) {
  const you = normalizeRole(yourRole);
  return (
    <section className={styles.block} aria-labelledby="team-roles-title">
      <span className="eyebrow">Roles</span>
      <h3 id="team-roles-title">Who can do what</h3>
      <ul className={styles.roles}>
        {ROLES.map((r) => (
          <li key={r} data-you={r === you || undefined}>
            <strong>{ROLE_INFO[r].label}</strong>
            {r === you && <span className="badge green">You</span>}
            <p>{ROLE_INFO[r].can.join(". ")}.</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- keys and members ----------

function NewKeyForm({ team, apiKey, ws, onCreated }) {
  const roles = keyRoles(team.your_role);
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [role, setRole] = useState("dev");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsLimit = team.budget_usd != null;
  const left = needsLimit ? Math.max(0, team.budget_usd - (team.allocated_usd || 0)) : null;
  return (
    <form
      className={styles.inlineForm}
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        const l = parseBudget(limit);
        if (!l.ok) return setError("Enter a limit in USD of 0 or more.");
        if (needsLimit && l.value == null) return setError(`This organisation has a budget, so the key needs a limit (up to ${formatUsd(left)} is free).`);
        if (!roles.includes(role)) return setError("Choose a role you may give.");
        setBusy(true);
        try {
          const body = { name: name.trim() || `${roleLabel(role)} key`, role, ...(l.value != null ? { limit: l.value } : {}), ...(ws?.me?.management ? { team: team.id } : {}) };
          const r = await api("/api/v1/keys", { key: apiKey, method: "POST", body });
          setName("");
          setLimit("");
          await onCreated(r);
        } catch (err) {
          setError(err?.type === "org_budget_exceeded" ? `That limit would take the keys past the organisation budget: ${formatUsd(left)} is free.` : message(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Err>{error}</Err>
      <div className={styles.formRow}>
        <div className="field">
          <label htmlFor="team-key-name">Key name</label>
          <input id="team-key-name" value={name} maxLength={100} placeholder="e.g. Staging app" onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="team-key-limit">Limit / USD{needsLimit ? "" : " (optional)"}</label>
          <input id="team-key-limit" type="number" inputMode="decimal" min="0" step="any" value={limit} placeholder={needsLimit ? `Up to ${formatUsd(left)}` : "No limit"} onChange={(e) => setLimit(e.target.value)} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="team-key-role">Role</label>
          <select id="team-key-role" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create key"}
      </Button>
    </form>
  );
}

function KeysSection({ team, live, apiKey, ws, notify, onChanged, onSecret }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const you = live ? team.your_role : "owner"; // the sample shows what an owner sees, with every control disabled
  const options = assignableRoles(you);
  const canCreate = live && atLeast(team.your_role, "dev");
  const rows = team.members || [];
  async function setRole(m, role) {
    setBusy(m.key_hash);
    setError("");
    try {
      await api(`/api/v1/teams/${enc(team.id)}/members/${enc(m.key_hash)}`, { key: apiKey, method: "PUT", body: { role } });
      await onChanged();
      notify?.(`${m.name || "The key"} is now ${roleLabel(role).toLowerCase()} in ${team.name}.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className={styles.section} aria-labelledby="team-keys-title">
      <div className={styles.sectionHead}>
        <div>
          <h3 id="team-keys-title">Keys in this organisation</h3>
          <p className="help-text">API keys carry a role here. An agent key calls models and nothing else; the keys a passkey or wallet member signs in with manage the organisation and cannot spend (limit 0).</p>
        </div>
        {canCreate && !creating && (
          <button type="button" className="text-button" onClick={() => setCreating(true)}>
            New key in this organisation →
          </button>
        )}
      </div>
      {creating && (
        <NewKeyForm
          team={team}
          apiKey={apiKey}
          ws={ws}
          onCreated={async (r) => {
            setCreating(false);
            await onChanged();
            if (onSecret) onSecret(r.key, r.deposit, "Your new organisation key");
            notify?.(`Created ${r.data?.name || "a key"} in ${team.name}.`);
          }}
        />
      )}
      <Err>{error}</Err>
      {rows.length ? (
        <div className="table-wrap">
          <table className={"data-table " + routeStyles.table}>
            <thead>
              <tr>
                <th>Key</th>
                <th>Role</th>
                <th>Member</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => (
                <tr key={m.key_hash} style={{ "--i": Math.min(i, 12) }}>
                  <td className="cell-primary">
                    <strong>{m.name || "Unnamed key"}</strong>
                    <code className={routeStyles.slug}>{shortHex(m.key_hash, 16)}…</code>
                    {live && ws?.me?.hash === m.key_hash && <span className="badge green">This key</span>}
                  </td>
                  <td data-label="Role">
                    {canManage(you, m.role) && options.length ? (
                      <RoleSelect label={`Role of ${m.name || "this key"}`} value={m.role} options={options} disabled={!live || !!busy} onChange={(r) => setRole(m, r)} />
                    ) : (
                      roleLabel(m.role)
                    )}
                  </td>
                  <td data-label="Member">{m.principal ? <code className="mono">{m.principal}</code> : <span className={routeStyles.none}>Key only</span>}</td>
                  <td data-label="Status">{m.disabled ? <span className="badge">Disabled</span> : <span className="badge green">Active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={routeStyles.none}>No keys in this organisation yet.</p>
      )}
    </section>
  );
}

function RevokeDialog({ team, principal, apiKey, onClose, onRevoked }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Revoke ${principal.id}?`} onClose={onClose}>
      <p>
        This {principal.kind === "wallet" ? "wallet" : "passkey"} can no longer sign in to {team.name}, and every key issued to it is disabled at once. The member stays in the list, marked disabled, and the audit log records who revoked it. Restoring it later lets it sign in for a new key; the disabled keys stay disabled.
      </p>
      <Err>{error}</Err>
      <div className="button-row modal-actions">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api(`/api/v1/teams/${enc(team.id)}/principals/${enc(principal.id)}`, { key: apiKey, method: "DELETE" });
              await onRevoked(r.data);
            } catch (e) {
              setError(message(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Revoking…" : "Revoke member"}
        </Button>
        <Button secondary onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

function PrincipalsSection({ team, live, apiKey, notify, onChanged }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState(null);
  const you = live ? team.your_role : "owner";
  const options = inviteRoles(you);
  // The owner's wallet or Safe is a member with the owner role: it changes only by binding a new owner.
  const manageable = (p) => p.role !== "owner" && canManage(you, p.role) && options.length > 0;
  const rows = team.principals || [];
  async function patch(p, body, done) {
    setBusy(p.id);
    setError("");
    try {
      await api(`/api/v1/teams/${enc(team.id)}/principals/${enc(p.id)}`, { key: apiKey, method: "PATCH", body });
      await onChanged();
      notify?.(done);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className={styles.section} aria-labelledby="team-people-title">
      <div className={styles.sectionHead}>
        <div>
          <h3 id="team-people-title">Passkey and wallet members</h3>
          <p className="help-text">The router keeps a passkey’s public key or a wallet address, and nothing else about a member: no email, no name.</p>
        </div>
      </div>
      <Err>{error}</Err>
      {rows.length ? (
        <div className="table-wrap">
          <table className={"data-table " + routeStyles.table}>
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Joined</th>
                <th>Last used</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.id} style={{ "--i": Math.min(i, 12) }} className={p.disabled ? styles.muted : undefined}>
                  <td className="cell-primary">
                    <strong>{p.kind === "wallet" ? "Wallet" : "Passkey"}</strong>
                    <code className={routeStyles.slug} title={p.subject}>
                      {p.kind === "wallet" ? shortAddr(p.subject) : p.subject}
                    </code>
                    <small className={routeStyles.description}>{p.id}</small>
                    {p.disabled && <span className="badge">Disabled</span>}
                  </td>
                  <td data-label="Role">
                    {manageable(p) ? (
                      <RoleSelect label={`Role of ${p.id}`} value={p.role} options={options} disabled={!live || !!busy || p.disabled} onChange={(r) => patch(p, { role: r }, `${p.id} is now ${roleLabel(r).toLowerCase()}.`)} />
                    ) : (
                      roleLabel(p.role)
                    )}
                  </td>
                  <td data-label="Joined">{when(p.created_at)}</td>
                  <td data-label="Last used">{when(p.last_used)}</td>
                  <td className="cell-action">
                    {manageable(p) && (
                      <div className={routeStyles.actions}>
                        {p.disabled ? (
                          <button type="button" className="text-button" disabled={!live || !!busy} title={live ? undefined : SAMPLE} onClick={() => patch(p, { disabled: false }, `${p.id} can sign in again. Its old keys stay disabled.`)}>
                            Restore
                          </button>
                        ) : (
                          <button type="button" className={"text-button " + styles.danger} disabled={!live || !!busy} title={live ? undefined : SAMPLE} onClick={() => setRevoking(p)}>
                            Revoke
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={routeStyles.none}>No one has joined yet. Send an invite below.</p>
      )}
      {revoking && (
        <RevokeDialog
          team={team}
          principal={revoking}
          apiKey={apiKey}
          onClose={() => setRevoking(null)}
          onRevoked={async (r) => {
            setRevoking(null);
            await onChanged();
            notify?.(`Revoked ${r?.id || "the member"}. ${r?.keys_disabled ?? 0} key${r?.keys_disabled === 1 ? "" : "s"} disabled.`);
          }}
        />
      )}
    </section>
  );
}

function InviteSection({ team, live, apiKey, onChanged }) {
  const roles = inviteRoles(live ? team.your_role : "owner");
  const [role, setRole] = useState("dev");
  const [method, setMethod] = useState("any");
  const [ttl, setTtl] = useState(String(TTL.default));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = created ? joinLink(created.invite, origin) : "";
  useEffect(() => setCreated(null), [team.id]);
  return (
    <section className={styles.section} aria-labelledby="team-invite-title">
      <div className={styles.sectionHead}>
        <div>
          <h3 id="team-invite-title">Invite a member</h3>
          <p className="help-text">An invite is shown once and works once: whoever opens the link first joins with a passkey or a wallet in the role you choose, until it expires. Admins invite developers and viewers; the owner can also invite admins. Agents are not invited: give an agent an API key with the agent role.</p>
        </div>
      </div>
      <Err>{error}</Err>
      <form
        className={styles.inlineForm}
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const problem = validateInvite({ role, method, ttl }, live ? team.your_role : "owner");
          if (problem) return setError(problem);
          setError("");
          setBusy(true);
          try {
            const r = await api(`/api/v1/teams/${enc(team.id)}/invites`, { key: apiKey, method: "POST", body: { role, method, ttl_hours: Number(ttl) } });
            setCreated(r.data);
            await onChanged();
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className={styles.plain} disabled={!live || busy} title={live ? undefined : SAMPLE}>
          <div className={styles.formRow}>
            <div className="field">
              <label htmlFor="invite-role">Role</label>
              <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="invite-method">Signs in with</label>
              <select id="invite-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                {INVITE_METHODS.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="invite-ttl">Expires after / hours</label>
              <input id="invite-ttl" type="number" inputMode="numeric" min={TTL.min} max={TTL.max} step="1" value={ttl} onChange={(e) => setTtl(e.target.value)} />
            </div>
          </div>
          <Button type="submit">{busy ? "Creating…" : "Create invite"}</Button>
        </fieldset>
      </form>
      {created && (
        <div className={styles.once} role="status">
          <span className="eyebrow">Invite · shown once</span>
          <p>
            Joins as <strong>{roleLabel(created.role)}</strong> with {INVITE_METHODS.find(([m]) => m === created.method)?.[1].toLowerCase() || "a passkey or wallet"}. Expires {when(created.expires_at)}. Send it over a channel you trust: anyone who has it can use it.
          </p>
          <Code label="Join link">{link}</Code>
          <div className="button-row">
            <CopyButton text={created.invite} label="Copy the invite code only" />
            <button type="button" className="text-button" onClick={() => setCreated(null)}>
              I sent it
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- the audit log ----------

function Verdict({ v }) {
  if (!v) return null;
  const where = v.seq != null ? `entry ${v.seq}` : v.hour ? `the root for ${v.hour}` : "the header";
  return (
    <div className={styles.verdict} data-state={v.state} role="status" aria-live="polite">
      {v.state === "running" ? (
        <>Recomputing every hash{v.file ? ` in ${v.file}` : ""}…</>
      ) : v.state === "ok" ? (
        <>
          <strong>Chain intact{v.file ? ` · ${v.file}` : ""}.</strong> {v.checked} entr{v.checked === 1 ? "y" : "ies"} recomputed from the genesis hash
          {v.roots ? `, and ${v.roots} hourly Merkle root${v.roots === 1 ? "" : "s"}` : ""}. Head <code className="mono">{v.head}</code>. Keep this head: a later export must contain the same entries with the same hashes.
        </>
      ) : v.state === "broken" ? (
        <>
          <strong>Broken at {where}.</strong> {v.message}
        </>
      ) : (
        <>
          <strong>Could not check.</strong> {v.message}
        </>
      )}
    </div>
  );
}

function AuditSection({ team, live, apiKey, sampleEntries }) {
  const total = team.audit?.entries ?? 0;
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [verdict, setVerdict] = useState(null);
  const [busy, setBusy] = useState("");
  const [tampered, setTampered] = useState(false);
  const pages = pageCount(total, PAGE);
  // Sample mode: the fixed log, optionally with one entry changed after it was written, to show what a check catches.
  const sample = useMemo(() => (live || !sampleEntries ? null : tampered ? sampleEntries.map((e) => (e.seq === 4 ? { ...e, detail: { ...e.detail, role: "owner" } } : e)) : sampleEntries), [live, sampleEntries, tampered]);

  useEffect(() => {
    setPage(0);
    setVerdict(null);
  }, [team.id]);
  useEffect(() => {
    const { after, limit } = auditPage(total, page, PAGE);
    if (!live) {
      setRows(sample ? sample.filter((e) => e.seq > after && e.seq <= after + limit).reverse() : null);
      return;
    }
    if (limit <= 0) {
      setRows([]);
      return;
    }
    let alive = true;
    setError("");
    api(`/api/v1/teams/${enc(team.id)}/audit?after=${after}&limit=${limit}`, { key: apiKey })
      .then((r) => alive && setRows([...(r.data || [])].reverse()))
      .catch((e) => {
        if (!alive) return;
        setError(message(e));
        setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [live, apiKey, team.id, total, page, sample]);

  async function verify() {
    setBusy("verify");
    setVerdict({ state: "running" });
    try {
      let entries = [];
      let head = null;
      let genesis = GENESIS;
      let roots = [];
      if (live) {
        let after = 0;
        for (let i = 0; i < 1000; i++) {
          const r = await api(`/api/v1/teams/${enc(team.id)}/audit?after=${after}&limit=500`, { key: apiKey });
          entries.push(...(r.data || []));
          head = r.head || head;
          if (r.genesis) genesis = r.genesis;
          if (r.next_after == null || !r.data?.length) break;
          after = r.next_after;
        }
        roots = (await api(`/api/v1/teams/${enc(team.id)}/audit/roots`, { key: apiKey })).data || [];
      } else {
        entries = sample || [];
        head = { seq: sampleEntries.length, hash: sampleEntries.at(-1)?.hash };
        roots = await hourlyRoots(sampleEntries);
      }
      const chain = await verifyChain(entries, { genesis, team: team.id, head });
      if (!chain.ok) return setVerdict({ state: "broken", ...chain });
      // A root for the current hour may already cover an entry written after the pages above were read: check only whole ones.
      const last = entries.at(-1)?.seq ?? 0;
      const rootCheck = await verifyRoots(entries, roots.filter((r) => r.last_seq <= last));
      if (!rootCheck.ok) return setVerdict({ state: "broken", ...rootCheck });
      setVerdict({ state: "ok", checked: chain.checked, head: chain.head ?? genesis, roots: rootCheck.checked });
    } catch (e) {
      setVerdict({ state: "error", message: message(e) });
    } finally {
      setBusy("");
    }
  }

  async function download(format) {
    setBusy(format);
    setError("");
    try {
      if (!live) {
        const text = format === "csv" ? exportCsv(sample, team.id) : await exportJsonl(team.id, sample);
        return saveBlob(new Blob([text], { type: format === "csv" ? "text/csv" : "application/jsonl" }), `anyroute-audit-${team.id}-sample.${format}`);
      }
      const res = await fetch(`${API_BASE}/api/v1/teams/${enc(team.id)}/audit/export?format=${format}`, { headers: { authorization: "Bearer " + apiKey } });
      if (!res.ok) {
        let m = "";
        try {
          m = (await res.json())?.error?.message || "";
        } catch {
          /* not JSON */
        }
        throw new Error(m || `The export failed (${res.status}).`);
      }
      saveBlob(await res.blob(), dispositionName(res.headers.get("content-disposition")) || `anyroute-audit-${team.id}.${format}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }

  async function checkFile(file) {
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) return setVerdict({ state: "error", file: file.name, message: "This file is over 64 MB. Check it offline with the command below." });
    setBusy("file");
    setVerdict({ state: "running", file: file.name });
    try {
      const parsed = parseExport(await file.text());
      const result = await verifyExport(parsed, { team: team.id });
      setVerdict({ state: result.ok ? "ok" : "broken", file: file.name, ...result });
    } catch (e) {
      setVerdict({ state: "error", file: file.name, message: message(e) });
    } finally {
      setBusy("");
    }
  }

  const { after } = auditPage(total, page, PAGE);
  return (
    <section className={styles.section} aria-labelledby="team-audit-title">
      <div className={styles.sectionHead}>
        <div>
          <h3 id="team-audit-title">Audit log</h3>
          <p className="help-text">Who changed what and when: members, roles, invites, keys, budgets, presets and routes. Never what anyone asked a model. Each entry’s hash covers the one before it, so an edit, a removal or a reordering breaks every hash after it.</p>
        </div>
      </div>
      <div className={styles.toolbar}>
        <div className="button-row">
          <Button onClick={verify} disabled={!!busy || (!live && !sample)}>
            {busy === "verify" ? "Verifying…" : "Verify chain"}
          </Button>
          <Button secondary onClick={() => download("jsonl")} disabled={!!busy || (!live && !sample)}>
            {busy === "jsonl" ? "Exporting…" : "Export JSONL"}
          </Button>
          <Button secondary onClick={() => download("csv")} disabled={!!busy || (!live && !sample)}>
            {busy === "csv" ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
        <div className={styles.toolbarRight}>
          {!live && (
            <button
              type="button"
              className="text-button"
              aria-pressed={tampered}
              onClick={() => {
                setTampered((t) => !t);
                setVerdict(null);
              }}
            >
              {tampered ? "Undo the change to entry 4" : "Make entry 4 say owner"}
            </button>
          )}
          <label className={"text-button " + styles.fileLabel}>
            {busy === "file" ? "Checking…" : "Check an export file"}
            <input
              type="file"
              className="sr-only"
              accept=".jsonl,.csv,application/jsonl,text/csv"
              disabled={!!busy}
              onChange={(e) => {
                checkFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      <Verdict v={verdict} />
      <Err>{error}</Err>
      {rows === null ? (
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Loading the audit log…
        </div>
      ) : rows.length ? (
        <>
          <div className="table-wrap">
            <table className={"data-table " + styles.audit}>
              <thead>
                <tr>
                  <th className="num">Seq</th>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => (
                  <tr key={e.seq} style={{ "--i": Math.min(i, 12) }} className={verdict?.state === "broken" && verdict.seq === e.seq ? styles.brokenRow : undefined}>
                    <td className="num" data-label="Seq" title={"hash " + e.hash}>
                      {e.seq}
                    </td>
                    <td data-label="Time">
                      <time dateTime={e.at} title={e.at}>
                        {when(e.at)}
                      </time>
                    </td>
                    <td data-label="Actor">
                      <span className="mono" title={e.actor}>
                        {actorLabel(e.actor)}
                      </span>
                    </td>
                    <td data-label="Action">
                      <strong>{actionLabel(e.action)}</strong>
                      {detailText(e.detail) && <small className={styles.detail}>{detailText(e.detail)}</small>}
                    </td>
                    <td data-label="Target">
                      <code className={styles.target}>{e.target}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.pager}>
            <button type="button" className="text-button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Newer
            </button>
            <span>
              Entries {after + 1} to {after + rows.length} of {total} · page {page + 1} of {pages}
            </span>
            <button type="button" className="text-button" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
              Older →
            </button>
          </div>
        </>
      ) : (
        !error && <p className={routeStyles.none}>No entries yet.</p>
      )}
      <div className={styles.offline}>
        <Code label="Check an export offline, with no network">{`node scripts/verify-audit.mjs anyroute-audit-${team.id}.jsonl`}</Code>
        <p className="help-text">
          The script and Verify chain recompute every hash from 64 zeros: h = sha256(previous hash bytes || canonical JSON of the entry’s team, seq, at, actor, action, target and detail), then each hour’s RFC 6962 Merkle root. The router writes the log, so a check proves the log was not changed after the head you kept; it cannot prove the router logged every event.
        </p>
      </div>
    </section>
  );
}

// ---------- joining and signing in (no key needed) ----------

/** Busy and error state for the join and sign-in buttons. */
function useAction() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function run(label, fn) {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  return { busy, error, setError, run };
}

async function makePasskey(publicKey) {
  if (!passkeysSupported()) throw new Error("This browser cannot use passkeys. Use a wallet, or open this page in a browser that supports passkeys.");
  try {
    const cred = await navigator.credentials.create({ publicKey: credentialCreateOptions(publicKey) });
    if (!cred) throw new Error("No passkey was made.");
    return cred;
  } catch (e) {
    throw new Error(passkeyError(e));
  }
}
async function getPasskey(publicKey) {
  if (!passkeysSupported()) throw new Error("This browser cannot use passkeys. Use a wallet, or open this page in a browser that supports passkeys.");
  try {
    const cred = await navigator.credentials.get({ publicKey: credentialGetOptions(publicKey) });
    if (!cred) throw new Error("No passkey was chosen.");
    return cred;
  } catch (e) {
    throw new Error(passkeyError(e));
  }
}

function JoinPanel({ live, initial, onIssued, highlight }) {
  const [text, setText] = useState(initial || "");
  const { busy, error, setError, run } = useAction();
  const code = extractInvite(text);
  const join = (method) =>
    run(method, async () => {
      if (!code) throw new Error("Paste an invite code (ar-inv- followed by 48 hex characters) or the whole join link.");
      let r;
      if (method === "passkey") {
        const ch = (await api("/api/v1/teams/join/challenge", { method: "POST", body: { invite: code, method: "passkey" } })).data;
        const cred = await makePasskey(ch.publicKey);
        r = await api("/api/v1/teams/join", { method: "POST", body: { invite: code, challenge_id: ch.challenge_id, passkey: encodeRegistration(cred) } });
      } else {
        const address = await connect();
        const ch = (await api("/api/v1/teams/join/challenge", { method: "POST", body: { invite: code, method: "wallet", address } })).data;
        const signature = await personalSign(address, ch.message);
        r = await api("/api/v1/teams/join", { method: "POST", body: { invite: code, challenge_id: ch.challenge_id, wallet: { address, signature } } });
      }
      setText("");
      await onIssued(r, "Your organisation key");
    });
  return (
    <section className={styles.panel} data-highlight={highlight || undefined} aria-labelledby="team-join-title">
      <span className="eyebrow">{highlight ? "You were invited" : "Have an invite?"}</span>
      <h3 id="team-join-title">Join an organisation</h3>
      <p>Make a passkey on this device, or sign with a wallet. The organisation learns a public key or an address, nothing else.</p>
      <Err>{error}</Err>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          join("passkey");
        }}
      >
        <fieldset className={styles.plain} disabled={!live || !!busy} title={live ? undefined : SAMPLE}>
          <div className="field">
            <label htmlFor="join-invite">Invite code or link</label>
            <input
              id="join-invite"
              className="mono"
              value={text}
              autoComplete="off"
              spellCheck={false}
              placeholder="ar-inv-…"
              onChange={(e) => {
                setText(e.target.value);
                setError("");
              }}
            />
          </div>
          <div className="button-row">
            <Button type="submit">{busy === "passkey" ? "Waiting for the passkey…" : "Join with a passkey"}</Button>
            <Button type="button" secondary onClick={() => join("wallet")}>
              {busy === "wallet" ? "Waiting for the wallet…" : "Join with a wallet"}
            </Button>
          </div>
        </fieldset>
      </form>
      <p className="help-text">You get a key that manages the organisation in your role for 12 hours. It cannot spend (limit 0): to call models, a developer or admin creates an API key. Joining signs this tab in with it.</p>
    </section>
  );
}

function SignInPanel({ live, initialTeam, onIssued }) {
  const [teamId, setTeamId] = useState(initialTeam || "");
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (initialTeam) setTeamId((t) => t || initialTeam);
  }, [initialTeam]);
  const id = teamId.trim();
  const signIn = (method) =>
    run(method, async () => {
      if (!/^team_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Enter the organisation id: team_ followed by letters and digits.");
      let r;
      if (method === "passkey") {
        const ch = (await api(`/api/v1/teams/${enc(id)}/sign-in/challenge`, { method: "POST", body: { method: "passkey" } })).data;
        const cred = await getPasskey(ch.publicKey);
        r = await api(`/api/v1/teams/${enc(id)}/sign-in`, { method: "POST", body: { challenge_id: ch.challenge_id, passkey: encodeAssertion(cred) } });
      } else {
        const address = await connect();
        const ch = (await api(`/api/v1/teams/${enc(id)}/sign-in/challenge`, { method: "POST", body: { method: "wallet", address } })).data;
        const signature = await personalSign(address, ch.message);
        r = await api(`/api/v1/teams/${enc(id)}/sign-in`, { method: "POST", body: { challenge_id: ch.challenge_id, wallet: { address, signature } } });
      }
      await onIssued(r, "Your organisation key · 12 hours", id);
    });
  return (
    <section className={styles.panel} aria-labelledby="team-signin-title">
      <span className="eyebrow">Already a member?</span>
      <h3 id="team-signin-title">Sign in to an organisation</h3>
      <p>Use the passkey or wallet you joined with. The owner wallet or Safe signs in as owner.</p>
      <Err>{error}</Err>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          signIn("passkey");
        }}
      >
        <fieldset className={styles.plain} disabled={!live || !!busy} title={live ? undefined : SAMPLE}>
          <div className="field">
            <label htmlFor="signin-team">Organisation id</label>
            <input id="signin-team" className="mono" value={teamId} autoComplete="off" spellCheck={false} placeholder="team_…" onChange={(e) => setTeamId(e.target.value)} />
          </div>
          <div className="button-row">
            <Button type="submit">{busy === "passkey" ? "Waiting for the passkey…" : "Sign in with a passkey"}</Button>
            <Button type="button" secondary onClick={() => signIn("wallet")}>
              {busy === "wallet" ? "Waiting for the wallet…" : "Sign in with a wallet"}
            </Button>
          </div>
        </fieldset>
      </form>
      <p className="help-text">The key it returns expires after 12 hours and cannot spend. This browser remembers the last organisation id you used, and nothing else.</p>
    </section>
  );
}

function CreateTeamDialog({ apiKey, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="New organisation" onClose={onClose}>
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const b = parseBudget(budget);
          if (!name.trim()) return setError("Give the organisation a name. Members see it; it need not be a real one.");
          if (!b.ok) return setError(b.error);
          setError("");
          setBusy(true);
          try {
            const r = await api("/api/v1/teams", { key: apiKey, method: "POST", body: { name: name.trim(), ...(b.value != null ? { budget_usd: b.value } : {}) } });
            await onCreated(r.data);
          } catch (err) {
            setError(message(err));
            setBusy(false);
          }
        }}
      >
        <p>Your management key is its owner. Invite members next: they join with a passkey or a wallet, never an email.</p>
        <Err>{error}</Err>
        <div className="field">
          <label htmlFor="new-team-name">Name</label>
          <input id="new-team-name" value={name} maxLength={80} autoFocus placeholder="e.g. Research" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-team-budget">Budget / USD (optional)</label>
          <input id="new-team-budget" type="number" inputMode="decimal" min="0" step="any" placeholder="No budget" value={budget} onChange={(e) => setBudget(e.target.value)} aria-describedby="new-team-budget-hint" />
          <small className={routeStyles.hint} id="new-team-budget-hint">
            The most the keys in this organisation may hold in limits, together.
          </small>
        </div>
        <div className="button-row modal-actions">
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create organisation"}
          </Button>
          <Button type="button" secondary onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- the tab ----------

export default function Teams({ live, apiKey, ws, notify, signedIn, onKey, onSecret }) {
  const [teams, setTeams] = useState(null); // null while loading
  const [loadError, setLoadError] = useState("");
  const [agentKey, setAgentKey] = useState(false);
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState(null); // a returned key, when the dashboard has no dialog for it
  const [accessError, setAccessError] = useState("");
  const [lastTeam, setLastTeam] = useState("");
  const [sealed, setSealed] = useState(null); // sample mode: the chained sample log
  const [invite] = useState(() => (typeof window === "undefined" ? "" : extractInvite(new URLSearchParams(window.location.search).get("join") || "")));
  const joinRef = useRef(null);
  const hasKey = live && !!apiKey && !!ws && signedIn !== false;
  const management = !!ws?.me?.management;

  // An invite link (/dashboard/?join=<invite>#teams): take the invite out of the address bar, then show the join panel.
  useEffect(() => {
    setLastTeam(recall());
    if (!invite) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    const frame = requestAnimationFrame(() => joinRef.current?.scrollIntoView({ block: "start", behavior: "auto" }));
    return () => cancelAnimationFrame(frame);
  }, [invite]);

  useEffect(() => {
    if (live) return;
    let alive = true;
    sealEntries(SAMPLE_TEAM_ID, sampleAuditEntries)
      .then((e) => alive && setSealed(e))
      .catch(() => alive && setSealed([]));
    return () => {
      alive = false;
    };
  }, [live]);

  async function load() {
    setLoadError("");
    setAgentKey(false);
    try {
      const r = await api("/api/v1/teams", { key: apiKey });
      setTeams(r.data || []);
      return r.data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setAgentKey(true);
      else setLoadError(message(e));
      setTeams((x) => x ?? []);
    }
  }
  useEffect(() => {
    if (hasKey) load();
    else setTeams(null);
  }, [hasKey, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function reloadTeam(id) {
    try {
      const r = await api(`/api/v1/teams/${enc(id)}`, { key: apiKey });
      setTeams((list) => (list || []).map((t) => (t.id === id ? r.data : t)));
    } catch {
      await load();
    }
  }

  async function onIssued(r, title, teamHint) {
    const key = r?.key;
    const team = r?.data?.team;
    const teamId = (typeof team === "string" ? team : team?.id) || teamHint;
    if (!key) throw new Error("The router did not return a key.");
    if (teamId) {
      remember(teamId);
      setLastTeam(teamId);
      setSelected(teamId);
    }
    setAccessError("");
    if (onSecret) onSecret(key, null, title);
    else setIssued({ key, title });
    try {
      await onKey?.(key);
    } catch (e) {
      setAccessError(`The key was issued but could not open the workspace: ${message(e)} Copy it from the dialog and connect it from Overview.`);
    }
    const role = r?.data?.principal?.role;
    notify?.(`Signed in to ${typeof team === "object" && team?.name ? team.name : "the organisation"}${role ? " as " + roleLabel(role).toLowerCase() : ""}.`);
  }

  const sampleView = useMemo(() => ({ ...sampleTeam, audit: { entries: sealed?.length ?? 0, head: sealed?.at(-1)?.hash ?? GENESIS } }), [sealed]);
  const rows = live ? teams || [] : [sampleView];
  const current = rows.find((t) => t.id === selected) || rows[0] || null;
  const canAdmin = current && (!live || atLeast(current.your_role, "admin"));

  const heading = (
    <div className="panel-heading">
      <div>
        <h2>Organisations with no email.</h2>
        <p className="help-text">Members join with a passkey or a wallet, never an email, a name or a password. Roles decide who manages keys and budgets, and every change lands in a hash-chained audit log anyone can check offline.</p>
      </div>
      {!live ? (
        <span className="badge">Sample organisation · not saved</span>
      ) : management ? (
        <Button onClick={() => setCreating(true)}>New organisation</Button>
      ) : current ? (
        <span className="badge green">{roleLabel(current.your_role)}</span>
      ) : null}
    </div>
  );

  const access = (
    <div className={styles.access} ref={joinRef}>
      <JoinPanel live={live} initial={invite} highlight={!!invite} onIssued={onIssued} />
      <SignInPanel live={live} initialTeam={live && current ? current.id : lastTeam} onIssued={onIssued} />
    </div>
  );

  return (
    <>
      {heading}
      {!live && (
        <div className="note">
          Organisations live on the router. This sample workspace has no account, so the organisation below is a fixed example: nothing can be changed, and joining or signing in needs the live workspace. The sample audit log is real hashing, so Verify chain and the export check work.{" "}
          <button
            className="text-button"
            onClick={() => {
              setMode("live");
              window.location.reload();
            }}
          >
            Switch to your live workspace →
          </button>
        </div>
      )}
      {live && !hasKey && <div className="note">No key is connected. Join an organisation with an invite, or sign in to one with your passkey or wallet, below. To create an organisation, connect a management key from Overview.</div>}
      <Err>{accessError}</Err>
      {issued && (
        <div className={styles.once} role="status">
          <span className="eyebrow">{issued.title} · shown once</span>
          <Code label="API key">{issued.key}</Code>
          <button type="button" className="text-button" onClick={() => setIssued(null)}>
            I saved it
          </button>
        </div>
      )}
      {invite && access}

      {live && hasKey && teams === null ? (
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Loading organisations…
        </div>
      ) : live && hasKey && agentKey ? (
        <div className="note">This key has the agent role: it calls models and nothing else, so it cannot read the organisation. Connect a viewer key or higher, or sign in with your passkey or wallet below.</div>
      ) : live && hasKey && loadError ? (
        <div className="error" role="alert">
          Could not load organisations: {loadError}{" "}
          <button className="text-button" onClick={load}>
            Retry
          </button>
        </div>
      ) : live && hasKey && !rows.length ? (
        <div className="empty">
          <h3>{management ? "No organisations yet." : "This key is not in an organisation."}</h3>
          <p>{management ? "Create one, set a budget and invite members with a passkey or a wallet." : "Join one with an invite below, or connect a management key to create one."}</p>
          {management && <Button onClick={() => setCreating(true)}>Create an organisation</Button>}
        </div>
      ) : current ? (
        <>
          {rows.length > 1 && (
            <>
              <div className={routeStyles.meta}>
                <span className="catalog-count">{rows.length} organisations</span>
              </div>
              <div className="table-wrap">
                <table className={"data-table " + routeStyles.table}>
                  <thead>
                    <tr>
                      <th>Organisation</th>
                      <th>Your role</th>
                      <th>Members</th>
                      <th className="num">Budget</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t, i) => (
                      <tr key={t.id} style={{ "--i": Math.min(i, 12) }} className={current.id === t.id ? routeStyles.current : undefined}>
                        <td className="cell-primary">
                          <strong>{t.name}</strong>
                          <code className={routeStyles.slug}>{t.id}</code>
                        </td>
                        <td data-label="Your role">{roleLabel(t.your_role)}</td>
                        <td data-label="Members">
                          {t.principals?.length ?? 0} · {t.members?.length ?? 0} keys
                        </td>
                        <td className="num" data-label="Budget">
                          {formatUsd(t.budget_usd)}
                        </td>
                        <td className="cell-action">
                          <button className="text-button" onClick={() => setSelected(t.id)} aria-label={`Open ${t.name}`}>
                            Open →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <article className={styles.team} aria-labelledby="team-title">
            <div className={styles.teamHead}>
              <div>
                <span className="eyebrow">{current.sample ? "Sample organisation · not live data" : "Organisation"}</span>
                <h2 id="team-title">{current.name}</h2>
                <div className={styles.teamId}>
                  <code className="mono">{current.id}</code>
                  <CopyButton text={current.id} label="Copy id" />
                  <span>Created {when(current.created_at)}</span>
                </div>
              </div>
            </div>
            <Facts team={current} />
            <div className={styles.split}>
              <OwnerBlock team={current} live={live} apiKey={apiKey} notify={notify} onChanged={() => reloadTeam(current.id)} />
              {canAdmin ? <SettingsForm team={current} live={live} apiKey={apiKey} notify={notify} onChanged={() => reloadTeam(current.id)} /> : <RoleGuide yourRole={current.your_role} />}
            </div>
            {live && !canAdmin && <div className="note">Your role is {roleLabel(current.your_role).toLowerCase()}: you can read the organisation and its audit log. Admins and the owner manage members, keys and the budget.</div>}
            <KeysSection team={current} live={live} apiKey={apiKey} ws={ws} notify={notify} onChanged={() => reloadTeam(current.id)} onSecret={onSecret} />
            <PrincipalsSection team={current} live={live} apiKey={apiKey} notify={notify} onChanged={() => reloadTeam(current.id)} />
            {canAdmin && <InviteSection team={current} live={live} apiKey={apiKey} onChanged={() => reloadTeam(current.id)} />}
            {canAdmin && (
              <div className={styles.section}>
                <RoleGuide yourRole={current.your_role} />
              </div>
            )}
            <AuditSection team={current} live={live} apiKey={apiKey} sampleEntries={live ? null : sealed} />
          </article>
        </>
      ) : null}

      {!invite && access}

      {creating && (
        <CreateTeamDialog
          apiKey={apiKey}
          onClose={() => setCreating(false)}
          onCreated={async (t) => {
            setCreating(false);
            await load();
            setSelected(t.id);
            notify?.(`Created ${t.name}. Invite members next.`);
          }}
        />
      )}
    </>
  );
}
