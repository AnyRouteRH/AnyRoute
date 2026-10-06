// B121
export default function ModelAlternativesDocs() {
  return <section id="errors"><h3>Errors: try a similar model</h3>
    <p>When a model’s providers are unavailable, Chat can offer up to three available models with the abilities your message needs. Choose one to switch the Chat model and resend the same message. Anyroute never switches for you. Suggestions cost nothing; the retry is a new call at the chosen model’s rates.</p>
    <p>Availability errors from chat completions, Messages and Responses can include a top-level <code>suggested_models</code> array, ranked by closest estimated request cost. Each item has <code>id</code>, <code>name</code>, <code>prompt_price</code> and <code>completion_price</code> in dollars per token, and <code>why</code>. An empty array means no matching model is available. The original error status, code and message stay the same. Client errors, policy denials, rate limits and proven-only route refusals do not receive suggestions. Availability can change before a retry. Ordinary requests remain readable in router memory on every lane.</p>
  </section>;
}
