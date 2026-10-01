const ITEMS=[['llama-3.3-70b','$0.60 / 1M'],['qwen3-32b','reasoning'],['deepseek-r1','reasoning'],['mistral-small','$0.20 / 1M'],['gemma-3-27b','open weights'],['kimi-k2','tools'],['glm-4.6','long context'],['gpt-oss-120b','open weights'],['llama-4-scout','vision'],['qwen3-235b','moe'],['attested route','tee evidence'],['encrypted chat','on-device encryption'],['agent rulebook','budgets · receipts'],['AnyRoute Network','early hosts'],['pay with','NVDA · USDG']];

/** Endless strip of routable models. Pauses on hover; static under reduced motion. */
export default function Ticker(){const row=ITEMS.map(([a,b])=><span key={a}>{a}<em>{b}</em></span>);return <div className="ticker" aria-label="Examples of routable models"><div className="ticker-track" aria-hidden="true">{row}{row}</div></div>}
