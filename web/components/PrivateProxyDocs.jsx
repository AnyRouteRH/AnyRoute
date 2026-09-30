import { Code } from "./UI";
import { privateProgram } from "../lib/private-proxy";

// "Make any AI app private in one command": the documentation section for anyroute-private (packages/private). A server
// component: it reads the served file when the site is built, so the SHA-256 it shows is that file's.

const SITE = "https://anyroute.tech";

const setup = `# 1. A Tor client on this machine. Skip this if Tor Browser is open: it listens on 127.0.0.1:9150.
brew install tor && brew services start tor       # Debian and Ubuntu: sudo apt install tor

# 2. Buy blind tokens with an API key that has credits. The purchase goes over Tor too.
export ANYROUTE_API_KEY=sk-ar-v1-…
node private.mjs buy --count 20

# 3. Start the proxy. It refuses to start unless Tor answers.
node private.mjs start

# 4. In the app's shell, or its settings: point it at the proxy.
export OPENAI_BASE_URL=http://127.0.0.1:8788/v1
export OPENAI_API_KEY=anyroute-private            # any non-empty value; the proxy discards it`;

const status = `node private.mjs status

Tor:              reachable at 127.0.0.1:9050 (Tor daemon)
Onion service:    <56 characters>.onion answers (3.1 s)
Unlinkable lane:  available over onion, <n> models
Blind tokens:     18 usable (18 x 10000 units; $0.36 of face value)
  The soonest expiry is 2026-10-08 00:00 UTC.`;

const call = `curl http://127.0.0.1:8788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<a model from /v1/models>","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# what the router receives, in full:
#   POST /api/v1/chat/completions   Host: <onion address>
#   Accept, Content-Type, Content-Length, Connection: close
#   Authorization: PrivateToken token=<one token>
#   X-Anyroute-Lane: unlinkable`;

export default function PrivateProxyDocs() {
  const file = privateProgram();
  return (
    <>
      <h2 id="private">Make any AI app private in one command.</h2>
      <p>
        anyroute-private is a small program that runs on your own computer and looks like the OpenAI API at http://127.0.0.1:8788/v1, so any app that lets you set a base URL can use it. Every call it receives is rebuilt from scratch and sent to AnyRoute’s onion
        service through your own Tor client, on the unlinkable lane, and paid with a blind token. It is Apache-2.0 licensed, has no dependencies to install, and is one file: node private.mjs.
      </p>
      <div className="note">
        What this hides, and what it does not. The router still reads every prompt: on this lane it terminates the connection and sees the request text in memory to route it, and an attested provider receives it. What is hidden is who sent the call and who paid for
        it. Tor keeps your network address from the router, and a blind token cannot be tied to the purchase it came from. Anything in your prompt that identifies you still identifies you. Encryption through the router to the enclave is planned, not built.
      </div>

      <h3 id="private-get">Get it, and check it.</h3>
      <p>
        The program is one file, {file.bytes.toLocaleString("en-US")} bytes{file.version ? `, version ${file.version}` : ""}, not minified, so you can read it before you run it. Download it, then compare its SHA-256 with this one:
      </p>
      <Code label={`Download and check (${SITE}/private.mjs)`}>{`curl -fsSLO ${SITE}/private.mjs
shasum -a 256 private.mjs        # or: sha256sum private.mjs`}</Code>
      <p>
        Expected SHA-256: <code className="mono" id="private-sha256">{file.sha256}</code>
      </p>
      <p>
        The hash and the file come from the same site, so this catches a damaged or swapped download but not a compromised site. To check the file against the source, build it yourself with Bun (bun packages/private/scripts/build.ts in the repository writes the same bytes); a check in
        the repository rebuilds it and fails if the served file differs. Downloading from the clearnet shows the site your address, though nothing about what you will do with the file. To avoid even that, fetch it through Tor: curl --proxy socks5h://127.0.0.1:9050 -fsSLO {SITE}/private.mjs.
        It needs Node 20 or later. It includes the two libraries it uses, with their licences, at the top of the file.
      </p>

      <h3 id="private-use">Four steps.</h3>
      <Code label="Set up (macOS or Linux)">{setup}</Code>
      <p>
        On the first run it asks the router for its onion address at its public name, through Tor (a Tor exit connects, your address never does), checks that the address is a valid version 3 onion address, saves it in ~/.anyroute, and uses it from then on; --onion gives one
        yourself. Tokens are kept in ~/.anyroute/tokens.json, a file only you can read (mode 0600) in a directory of mode 0700. ANYROUTE_HOME moves them.
      </p>

      <h3 id="private-does">What it does to each call.</h3>
      <ul>
        <li>
          <strong>Listens on 127.0.0.1 only</strong>, and refuses a request whose Host is not 127.0.0.1 or localhost, or that carries the Origin of a web page, so a page in your browser cannot spend your tokens. On a shared machine, --local-key makes the app present a secret.
        </li>
        <li>
          <strong>Sends a fixed set of headers</strong> written by the proxy: Host, Accept, Content-Type, Content-Length, Connection, Authorization: PrivateToken and X-Anyroute-Lane: unlinkable. Nothing the app sent is copied: not its API key (an OpenAI key in
          OPENAI_API_KEY is discarded, never forwarded), its user agent, cookies, referrer, SDK and tracing headers, or forwarded-address headers. The body goes through as it came, except that the OpenAI <code>user</code> field, which names an end user, is removed.
        </li>
        <li>
          <strong>Uses one token per OpenAI call, or a budget-covering set for Messages</strong>, taken out of the file before the call is sent, so it is never sent twice. A token the router refuses as spent or invalid is dropped and the call is tried with the next; a refusal for another reason (no attested
          provider for the model, a rate limit, a token too small for the request) keeps the token. A call sent and then lost is marked unconfirmed and its token is not used again.
        </li>
        <li>
          <strong>Puts each call on its own Tor circuit</strong>, with a fresh SOCKS user name, so two calls are not carried together. --shared-circuit reuses one, which is faster.
        </li>
        <li>
          <strong>Has no other way out.</strong> The only address it ever connects to is your Tor client’s SOCKS5 port (127.0.0.1:9050, or 9150 for Tor Browser, or --socks), and it asks for the onion service by name, never resolving it. It refuses to start unless a Tor client
          answers and the onion service reports the unlinkable lane available over Tor. If Tor stops, calls fail with 502; nothing falls back to a direct connection. When the tokens run out, calls fail with 402 and the command to buy more.
        </li>
      </ul>
      <Code label="One call, and what the router sees">{call}</Code>

      <h3 id="private-apps">Which apps.</h3>
      <p>
        It serves POST /v1/chat/completions (streamed or not), POST /v1/embeddings and GET /v1/models, which lists the models an attested provider can serve on this lane. Point any OpenAI-compatible SDK, command-line tool or editor extension that lets you set a base
        URL at http://127.0.0.1:8788/v1 with any non-empty API key. Cursor has an Override OpenAI Base URL setting under Settings, Models; Cursor may send requests from its own servers, which cannot reach an address on your computer and would see your prompts, so check that
        your version calls the API from your computer before relying on it. Claude Code and the Anthropic SDKs can use POST /v1/messages with blind tokens; see <a href="#claude-unlinkable" className="inline-link">Claude Code, unlinkable</a>. The Responses API is not supported by this proxy.
      </p>

      <h3 id="private-tokens">Tokens: cost and expiry.</h3>
      <div className="table-wrap">
        <table className="docs-table">
          <thead>
            <tr>
              <th>Size (--denomination)</th>
              <th>Face value</th>
              <th>Fits</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">1000</td>
              <td>$0.002</td>
              <td>short answers from inexpensive models</td>
            </tr>
            <tr>
              <td className="mono">10000 (default)</td>
              <td>$0.02</td>
              <td>most chat calls</td>
            </tr>
            <tr>
              <td className="mono">100000</td>
              <td>$0.20</td>
              <td>long answers, or expensive models</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        A token payment pays for one call, whatever the call costs; the rest of its value is not refunded. Messages calls can combine tokens to cover their estimated budget. The router holds the worst case for a call (the prompt, and max_tokens or the model’s maximum, at the model’s price) against the token’s face value. If that is more, it answers
        402 token_value_too_low and does not spend the token: lower max_tokens or buy a larger size. Face values are those of the router’s current keys; buy prints what you paid and status what you hold. Tokens expire at the end of the router’s redemption window, one to two
        weeks after they are bought; buy prints the time and status shows the next expiry, so buy what you will use soon. A purchase names your API key’s account; a token later shown to the router cannot be connected to it, but it hides only among the tokens of the same size
        bought in the same week, and buying one and spending it at once links the two by time.
      </p>
      <Code label="Check that everything is ready">{status}</Code>
      <p>
        Other limits of what this hides: someone who can watch both your connection into Tor and the router’s side can match calls by timing; the size and timing of a call are visible to the router; and a provider that receives a prompt that names you knows who you are. The
        lane is the one described above as <a href="#unlinkable-tor" className="inline-link">the unlinkable lane over Tor</a>. The tokens are Privacy Pass tokens (RFC 9578) made with RSA blind signatures (RFC 9474), the same ones buyTokens in @anyroute/client/blind buys.
      </p>
    </>
  );
}
