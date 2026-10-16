// J183
export default function ChatProjectsDocs() {
  return <section id="chat-projects">
    <h2>Chat in a project</h2>
    <p>Choose Project in Chat to group its future calls with a project in Activity and Insights. Set a folder project in History so chats in that folder inherit it. A chat’s own choice takes priority; clear it to follow the folder, then the key’s default. The running cost chip shows the chosen project. Earlier charges keep their original labels.</p>
    <p>Project budgets apply to Chat through the existing router checks. Chat shows the router’s budget refusal without asking you to add funds. Manage the account’s monthly project budgets in <a href="/dashboard/#insights">Insights</a>. Available budget details use the same account permissions; other keys can still enter a project name.</p>
    <p>Every send, retry, continuation, tool reply and summary sends the existing <code>X-Anyroute-Project</code> header when a chat or folder project is selected. Without a selection no header is added, so the key default still applies. Names use 1–48 letters, digits, dots, underscores or hyphens and become lowercase. Project labels are readable by Anyroute and are not signed receipt claims. The router reads request text in memory on every lane.</p>
    <p>Chat and folder choices use optional <code>project</code> fields in the existing passphrase-encrypted browser history; <code>null</code> follows the default. Enable and unlock history to keep and restore them. Locking history removes the folder default from later requests; a choice on the visible chat stays in memory until that chat is reset or the page closes. History exports and imports keep these choices; older exports still work. Downloads and Copy as code contain readable project labels. Markdown includes a chat’s own label but does not keep folder defaults.</p>
    <p>No new endpoint, configuration flag or migration is added. Existing <code>GET /api/v1/projects</code> and <code>GET /api/v1/projects/:name/budget</code> require an account management owner key; read-only keys remain refused. Calls use the existing Chat authentication and project budget enforcement.</p>
  </section>;
}
