import { Code } from './UI';
const curl = `curl https://anyroute.tech/api/v1/chat/completions \\
  -H "Authorization: Bearer $ANYROUTE_KEY" \\
  -H 'Content-Type: application/json' \\
  -H 'X-Anyroute-Project: research' \\
  -d '{"model":"<model>","messages":[{"role":"user","content":"Summarize this topic."}]}'

curl https://anyroute.tech/api/v1/keys/$KEY_HASH \\
  -X PATCH -H "Authorization: Bearer $MANAGEMENT_KEY" \\
  -H 'Content-Type: application/json' -d '{"project":"research"}'

curl 'https://anyroute.tech/api/v1/activity?project=research&format=csv' \\
  -H "Authorization: Bearer $ANYROUTE_KEY"`;
export default function ProjectsDocs() {
  return <section id="projects"><h2>Project tags</h2>
    <p>Group calls by project to see where spending goes. Give a key a default project or name one on an individual call, then filter Activity and Insights in the dashboard. Statements stay unchanged.</p>
    <p>Send <code>X-Anyroute-Project</code> on calls handled by the chat, text completion, Responses, Messages, Ollama, embeddings, rerank, encrypted Chat and RAG routes. Names use 1–48 letters, numbers, dots, underscores or hyphens and are stored in lowercase. Invalid names return 400 with an explanation. The header overrides the key’s default. Set or clear that default with <code>PATCH /api/v1/keys/:hash</code> and <code>{'{"project":"research"}'}</code> or <code>{'{"project":null}'}</code>, using the existing owner or admin permissions and account/team boundaries.</p>
    <p><code>GET /api/v1/activity?project=research</code> selects calls for that project; CSV adds a project column. Tagged calls include a project field in Activity JSON. <code>GET /api/v1/insights?project=research</code> filters spending, including refunds linked to matching calls. Insights requires <code>SPEND_INSIGHTS_ENABLED</code> (default false). Project breakdowns include up to 100 groups ranked by cost and 100 by calls; totals include all visible records. Untagged calls appear as “No project” when a project breakdown is present. Both readers keep their existing key and account access rules. Project filters bind Activity cursors.</p>
    <p>The unlinkable lane refuses project tags because reusable labels link calls. The tag is not part of the signed receipt. Anyroute can read this owner-chosen label and keeps it with the call. Use non-sensitive names; a label does not hide prompts from the router or prove which project produced a call. Headerless calls keep their existing reply shape. A batch uses the key’s current default when its calls run; submitting a batch with this header does not set its lines’ projects.</p>
    <Code lang="bash">{curl}</Code>
  </section>;
}
