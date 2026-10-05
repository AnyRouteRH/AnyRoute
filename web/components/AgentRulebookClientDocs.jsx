const js = `import { AnyRoute, AgentPolicyDenied, AgentKilled,
  AgentApprovalRequired } from "@anyroute/client";

const client = new AnyRoute({ baseUrl: routerUrl, apiKey });
const rules = await client.agent.rules(); // inherited rules and remaining USD caps
const decision = await client.agent.check({
  kind: "inference", model: modelId, lane: "public",
  est_cost_pico: "1000000000", max_output_tokens: 32, tools: [],
});
if (decision.decision === "allow") {
  try {
    await client.chat.completions.create({
      model: modelId, messages: [{ role: "user", content: "Hello" }], max_tokens: 32,
    });
  } catch (error) {
    if (error instanceof AgentPolicyDenied || error instanceof AgentKilled ||
        error instanceof AgentApprovalRequired) {
      console.error(error.message, error.reasons);
      // Never retry the denied call unchanged.
      // Approval refusals expose approval_id and poll when the router supplies them.
    } else { throw error; }
  }
} else { console.error(decision.reasons); }`;
const py = `from anyroute_client import (AnyRoute, AgentPolicyDenied,
    AgentKilled, AgentApprovalRequired)

with AnyRoute(router_url, api_key) as client:
    rules = client.agent.rules()
    decision = client.agent.check({
        "kind": "inference", "model": model_id, "lane": "public",
        "est_cost_pico": "1000000000", "max_output_tokens": 32, "tools": [],
    })
    if decision["decision"] == "allow":
        try:
            client.chat({"model": model_id, "messages": [
                {"role": "user", "content": "Hello"}], "max_tokens": 32})
        except (AgentPolicyDenied, AgentKilled, AgentApprovalRequired) as error:
            print(str(error), error.reasons)
            # Never retry the denied call unchanged.
    else:
        print(decision["reasons"])`;
const mcp = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"anyroute_agent_rules","arguments":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"anyroute_agent_check","arguments":{
    "model":"author/model","lane":"public",
    "est_input_tokens":100,"max_output_tokens":32,"tools":[]}}}`;
export default function AgentRulebookClientDocs() {
  return <><h3>Read and respect rules from MCP or an SDK</h3><p>The SDK code is in the repository; npm and PyPI releases are not published yet.</p><p>Check before expensive calls and never retry a denied call unchanged. Connect MCP at POST /mcp with the calling key in the Authorization header. anyroute_agent_rules returns that key’s rules, inherited rules, remaining rolling caps and kill state. anyroute_agent_check returns the REST decision and reasons unchanged; token estimates use the current model catalog. Supply est_cost_pico instead to provide an explicit cost estimate.</p><pre><code>{mcp}</code></pre><p>Both SDKs return the data object from /agents/me and /agents/check. Costs use decimal strings in pico USD: 10^12 pico equals one USD. A dry run reserves no budget, sends no prompt and creates no policy event; a later request is evaluated again and may be refused. Rulebook reads and dry runs remain available when the key is killed or its tool allowlist excludes these inspection tools.</p><pre><code>{js}</code></pre><pre><code>{py}</code></pre><p>AgentPolicyDenied, AgentKilled and AgentApprovalRequired preserve the router’s message, reasons, status, policy_sha256 and metadata in details. Approval refusals expose approval_id and poll only when supplied; these SDK methods do not create approvals or poll automatically. AGENT_POLICY_ENABLED must be enabled by the operator; it defaults to false. These interfaces do not change who reads inference text: Anyroute’s router reads ordinary chat text in memory; the encrypted-chat adapter forwards ciphertext.</p><p>Switched on at anyroute.tech.</p></>;
}
