"use client";
import { useEffect, useRef, useState } from 'react';
import { applyChunk, blankReply, formatContext, replyFacts } from '../../lib/harness.js';
import { formatUsd, receiptHref } from '../../lib/arena.js';
import { ReplyApproval } from './Limits';
import { contextMeter, contextSendBlock, summaryRequest, summarySeed } from '../../lib/context-meter.js';
import s from './ContextMeter.module.css';

export function useContextMeter({ lanes, find, system, draft, files, busy, auth, priv, limits, controllers, setInflight, refreshBalance, setLanes, setFocus, setEditing, voice, needKey, input }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState(null);
  const [queued, setQueued] = useState(null);
  const [notice, setNotice] = useState('');
  const previous = useRef(new Map());
  const active = useRef(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setLink(null); setQueued(null); setError(''); }, [priv.on, auth.key]);
  useEffect(() => {
    const smaller = lanes.some(l => {
      const model = find(l.modelId), old = previous.current.get(l.id);
      return old?.capacity && model?.context && model.context < old.capacity;
    });
    if (smaller) setNotice('This model has a smaller context window. The meter has been updated.');
    else if (lanes.some(l => previous.current.get(l.id)?.id !== l.modelId)) setNotice('');
    previous.current = new Map(lanes.map(l => [l.id, { id: l.modelId, capacity: find(l.modelId)?.context }]));
  }, [lanes, find]);
  // Let the existing history shell observe an empty chat, so its next save gets a new chat ID.
  useEffect(() => { if (queued && lanes.every(l => !l.messages.length)) { setLanes(Array.isArray(queued) ? queued : [queued]); setQueued(null); input.current?.focus(); } }, [queued, lanes, setLanes, input]);
  const block = contextSendBlock(lanes, find, system, draft, files);
  const summarize = async lane => {
    if (busy || active.current || needKey('send')) return;
    voice.stop(); setError('');
    const model = find(lane.modelId);
    if (model?.route) return setError('Choose a single model before summarizing so the same model makes the summary.');
    let request;
    try { request = summaryRequest(model, lane.messages, system); } catch (e) { setError(e.message); return; }
    const id = crypto.randomUUID(), ctl = new AbortController(), version = generation.current;
    controllers.current.set(id, ctl); active.current = true; setPending(id); setInflight(n => n + 1);
    let reply = blankReply();
    try {
      await limits.streamChat({ messageId: id, key: auth.key, body: request.body, signal: ctl.signal, headers: { 'x-title': 'Anyroute Chat', ...priv.headers() }, onEvent: ev => { reply = applyChunk(reply, ev); } });
      if (version !== generation.current) return;
      const seed = summarySeed(reply.text, model.id, id);
      const old = lanes.map(l => l.id === lane.id ? { ...l, messages: [...l.messages, { id: 'request-' + id, role: 'user', text: request.body.messages.at(-1).content, attachments: [] }, { ...reply, id, model: model.id, role: 'assistant', status: 'done' }] } : l);
      setLink({ old, next: [seed], system, privateMode: priv.on, showingOld: false, reply, omitted: request.omitted, seedId: seed.messages[0].id });
      setLanes([{ ...seed, messages: [] }]); setFocus(0); setEditing(null); setQueued(seed);
    } catch (e) {
      if (version === generation.current) setError(e.name === 'AbortError' ? 'Summary stopped. Any text already delivered is billed. Your chat is still here.' : e.message || 'The summary could not be made. Your chat is still here.');
    } finally {
      controllers.current.delete(id); active.current = false; setPending(false); setInflight(n => n - 1); refreshBalance();
    }
  };
  const visibleLink = link && link.privateMode === priv.on && lanes.some(l => l.messages.some(m => m.id === (link.showingOld ? link.reply.id || link.old.flatMap(x => x.messages).at(-1)?.id : link.seedId)));
  const openLinked = e => {
    e.preventDefault(); if (busy || !link) return;
    voice.stop();
    const current = lanes;
    const target = link.showingOld ? link.next : link.old;
    setLanes(target.map(l => ({ ...l, messages: [] }))); setQueued(target); setFocus(0); setEditing(null);
    setLink({ ...link, [link.showingOld ? 'old' : 'next']: current, showingOld: !link.showingOld });
    input.current?.focus();
  };
  return { meters: lanes.map(l => ({ lane: l, model: find(l.modelId), ...contextMeter({ model: find(l.modelId), messages: l.messages, system, draft, attachments: files }) })), block, pending, limits, error, notice, summarize, link: visibleLink ? link : null, openLinked };
}

export default function ContextMeter({ context, busy }) {
  return <div className={s.root} id="context-previous-chat">
    {context.meters.map(m => <div key={m.lane.id} className={s.meter} data-state={m.state}>
      <div className={s.row}><span>{context.meters.length > 1 ? `${m.model?.name || 'Model'} · ` : ''}Context: {m.capacity ? `about ${m.percent}% of ${formatContext(m.capacity)}` : 'window unavailable'}</span>
        {m.lane.messages.some(x => x.text?.trim()) && <button type="button" className={s.action} disabled={busy || context.pending || !m.model} onClick={() => context.summarize(m.lane)}>{context.pending ? 'Summarizing…' : 'Summarize and continue'}</button>}
      </div>
      {m.capacity && <meter min="0" max="100" value={Math.min(100, m.percent)} low="80" high="99" optimum="0" aria-label={`${m.model?.name || 'Selected model'} context used`} />}
      {(m.state === 'warning' || m.state === 'full') && <p role="status">{m.state === 'full' ? 'Context is full. Shorten your draft, summarize, or choose a model with more room before sending.' : 'Getting full: older messages may be cut'}</p>}
      {m.uncertain && <p>Image and document usage is approximate; extracted document text may use more room.</p>}
    </div>)}
    {context.meters.some(m => m.lane.messages.length) && <p>Summaries are billed as a normal reply, with a receipt. If needed, oldest messages are left out of the summary request. Your draft stays here.</p>}
    {context.pending && <ReplyApproval limits={context.limits} messageId={context.pending} />}
    {context.notice && <p role="status">{context.notice}</p>}
    {context.error && <p role="alert">{context.error}</p>}
    {context.link && <p><a href="#context-previous-chat" aria-disabled={busy || undefined} onClick={context.openLinked}>{context.link.showingOld ? 'Return to continued chat' : 'Open previous chat'}</a> · Available during this visit. {context.link.omitted > 0 && 'Older messages were left out of the summary request. '}<SummaryReceipt reply={context.link.reply} /></p>}
  </div>;
}

function SummaryReceipt({ reply }) {
  const facts = replyFacts(reply);
  return <span>Summary: {facts.tokensIn ?? '?'} in · {facts.tokensOut ?? '?'} out{facts.cost !== null && <> · {formatUsd(facts.cost)}</>}{facts.receiptId && <> · <a href={receiptHref(facts.receiptId)}>View receipt</a></>}</span>;
}
