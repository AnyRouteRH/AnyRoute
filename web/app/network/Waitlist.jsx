"use client";
import { useState } from "react";
import { ROLES, REGIONS, PAYOUTS, PRIVACY_PROMISE, validateWaitlist, submitWaitlist, deleteWaitlist } from "../../lib/network";
import s from "./network.module.css";

export default function Waitlist() {
  const [values, setValues] = useState({ role: "", hardware: "", readiness: "", region: "", contact: "", paid_in: "any", website: "" });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [entry, setEntry] = useState(null);
  const [deleteId, setDeleteId] = useState("");
  const [deleteCode, setDeleteCode] = useState("");
  const change = (e) => setValues({ ...values, [e.target.name]: e.target.value });
  const select = (name, label, options) => <label>{label}<select name={name} value={values[name]} onChange={change} required aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `${name}-error` : undefined}><option value="">Choose one</option>{options.map(([id, text]) => <option value={id} key={id}>{text}</option>)}</select>{errors[name] && <span id={`${name}-error`} className={s.error}>{errors[name]}</span>}</label>;
  async function submit(e) {
    e.preventDefault();
    const issues = validateWaitlist(values);
    setErrors(issues); setMessage("");
    if (Object.keys(issues).length) return;
    setBusy(true);
    try { const result = await submitWaitlist(values); setEntry(result); setDeleteId(result.id); setDeleteCode(result.delete_code); setValues({ role: "", hardware: "", readiness: "", region: "", contact: "", paid_in: "any", website: "" }); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function remove(e) {
    e.preventDefault(); setBusy(true); setMessage("");
    try { await deleteWaitlist(deleteId, deleteCode); setEntry(null); setDeleteId(""); setDeleteCode(""); setMessage("Your entry has been deleted."); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  return <div className={s.formArea}>
    {entry ? <div role="status" className={s.saved}><h3>You’re on the waitlist.</h3><p>Save both values below. Your delete code is shown once; we keep only its SHA-256. This is an interest sign-up, not permission to host.</p><dl><dt>Entry id</dt><dd><code>{entry.id}</code></dd><dt>Delete code</dt><dd><code>{entry.delete_code}</code></dd></dl></div> : <form onSubmit={submit} className={s.form}>
      {select("role", "I want to join as", ROLES)}
      <label>Hardware <span className={s.small}>GPU model and count; CPU TEE type (TDX, SEV-SNP, none or not sure). Up to 200 characters.</span><input name="hardware" value={values.hardware} onChange={change} maxLength={200} aria-invalid={!!errors.hardware} />{errors.hardware && <span className={s.error}>{errors.hardware}</span>}</label>
      <label>Readiness check result <span className={s.small}>Optional. Paste the summary line, up to 300 characters.</span><textarea name="readiness" value={values.readiness} onChange={change} maxLength={300} rows={3} aria-invalid={!!errors.readiness} />{errors.readiness && <span className={s.error}>{errors.readiness}</span>}</label>
      {select("region", "Region · continent only", REGIONS)}
      <label>How to reach you <span className={s.small}>Optional. A handle or email in whatever form you prefer, up to 120 characters.</span><input name="contact" value={values.contact} onChange={change} maxLength={120} autoComplete="off" aria-invalid={!!errors.contact} />{errors.contact && <span className={s.error}>{errors.contact}</span>}</label>
      {select("paid_in", "Paid in · payout preference", PAYOUTS)}
      <div className={s.honey} aria-hidden="true"><label>Website<input name="website" value={values.website} onChange={change} tabIndex={-1} autoComplete="off" /></label></div>
      <p className={s.small}>Describe hardware only. Please don’t paste prompts or other sensitive information. We keep a minute-specific keyed digest for rate limits; the owner can read your submitted fields. <a href="/keep/">What we keep</a>.</p>
      <p id="network-privacy" className={s.promise}>{PRIVACY_PROMISE}</p>
      <button type="submit" disabled={busy} aria-describedby="network-privacy" className="ar-button">{busy ? "Saving…" : "Join the waitlist"}</button>
    </form>}
    <p role="status" aria-live="polite" className={s.error}>{message}</p>
    <details className={s.delete}><summary>Delete a sign-up</summary><form onSubmit={remove} className={s.form}><label>Entry id<input value={deleteId} onChange={(e) => setDeleteId(e.target.value)} required pattern="[0-9a-f-]{36}" autoComplete="off" /></label><label>Delete code<input value={deleteCode} onChange={(e) => setDeleteCode(e.target.value)} required pattern="[0-9a-f]{64}" autoComplete="off" /></label><button type="submit" disabled={busy} className="ar-button secondary">Delete my entry</button></form></details>
    <noscript>Enable JavaScript to submit or delete a sign-up. The hardware checker works independently.</noscript>
  </div>;
}
