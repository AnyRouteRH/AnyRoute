# anyroute-private

Make any AI app private in one command.

A small program that runs on your computer and looks like the OpenAI API. Point any app that has a base-URL setting at it, and every call goes to AnyRoute through Tor, on the unlinkable lane, paid with a blind token.

```sh
brew install tor && brew services start tor     # or leave Tor Browser open
export ANYROUTE_API_KEY=sk-ar-v1-…              # a key with credits, used once to buy tokens
node private.mjs buy --count 20                 # the purchase goes over Tor too
node private.mjs start                          # serves http://127.0.0.1:8788/v1

export OPENAI_BASE_URL=http://127.0.0.1:8788/v1
export OPENAI_API_KEY=anyroute-private          # any non-empty value; it is discarded
```

`private.mjs` is one file: download it from the AnyRoute site (`/private.mjs`), check its SHA-256 against the one on the documentation page, and run it with Node 20 or later. It has no dependencies to install. The package's `anyroute-private` command is the same file.

## What this hides, and what it does not

**The router still reads every prompt.** On this lane it terminates the connection and sees the request text in memory to route it, and an attested provider receives it. End-to-end encryption through the router to the enclave is planned, not built.

What is hidden is **who sent the call** and **who paid for it**:

- Tor keeps your network address from the router. The router sees the onion service's address, the same for everyone, and reads no address header on these calls.
- A blind token cannot be tied to the purchase it came from. The router sees your account when you buy tokens, and sees only a finished token when you spend one; it cannot connect the two.

What it does not hide: anything in your prompt that identifies you; the size and timing of a call; a match by timing between your connection into Tor and the router's side, for someone who can watch both; and, if you spend a token right after buying it, the link that timing makes. A token hides among the tokens of the same size bought in the same week.

## Commands

| Command | What it does |
| --- | --- |
| `buy --key <API key> --count <n>` | Buys `n` blind tokens with an API key that has credits, over Tor. `--denomination 1000\|10000\|100000` picks their size (default 10000). Saved to `~/.anyroute/tokens.json`. |
| `start [--port 8788]` | Serves an OpenAI-compatible API on 127.0.0.1. Refuses to start unless a Tor client answers and the onion service reports the unlinkable lane available over Tor. Never uses the clearnet. |
| `status [--json]` | Shows whether Tor and the onion service answer, whether the lane is available, and how many tokens are left and when they expire. Exits 0 only when all is ready. |

Options for all commands: `--socks host:port` (default: a Tor daemon on 127.0.0.1:9050, then Tor Browser on 127.0.0.1:9150), `--onion <address>`, `--router <url>`, `--allow-remote-socks`. For `start`: `--local-key <secret>`, `--shared-circuit`, `--max-concurrent <n>`, `--timeout <seconds>`, `--quiet`. For `buy`: `--clearnet`. Environment: `ANYROUTE_API_KEY`, `ANYROUTE_HOME`, `ANYROUTE_SOCKS`, `ANYROUTE_ONION`, `ANYROUTE_ROUTER`. `--help` lists them.

## What it does to each call

- **Listens on 127.0.0.1 only**, and refuses a request whose `Host` is not 127.0.0.1 or localhost, or that carries a web page's `Origin`, so a page in your browser cannot spend your tokens. `--local-key` makes the app present a secret, for a shared machine.
- **Builds the request itself.** It sends `Host`, `Accept`, `Content-Type`, `Content-Length`, `Connection`, `Authorization: PrivateToken token=…` and `X-Anyroute-Lane: unlinkable`, and nothing else. Nothing the app sent is copied: not its API key (an OpenAI key in `OPENAI_API_KEY` is discarded), user agent, cookies, referrer, SDK or tracing headers, or forwarded-address headers. The body goes through as it came, except that the OpenAI `user` field, which names an end user, is removed.
- **Spends one token per call**, taken out of the token file before the call is sent, so it is never sent twice. A token the router refuses as spent or invalid is dropped and the call is tried with the next one. A refusal for another reason (no attested provider for the model, a rate limit, a token too small for the request) keeps the token. A call that was sent and then lost leaves its token marked unconfirmed, and it is not used again.
- **Puts each call on its own Tor circuit**, with a fresh SOCKS user name. `--shared-circuit` reuses one.
- **Has no other way out.** The only address it connects to is your Tor client's SOCKS5 port, and it asks for the onion service by name without resolving it. If Tor stops, calls fail with `502`. When the tokens run out they fail with `402` and the command to buy more. Nothing falls back to a direct connection. A SOCKS port on another machine is refused unless you pass `--allow-remote-socks`, because the request reaches the proxy unencrypted. The program also switches the runtime's own `fetch` off before anything else runs; `buy --clearnet` is the one command that is handed it, and only when you ask for it by name.

It serves `POST /v1/chat/completions` (streamed or not), `POST /v1/embeddings` and `GET /v1/models` (the models an attested provider serves on this lane). Claude Code, the Anthropic SDKs and the Responses API are not supported: the router takes those with an API key, which names you. Cursor has an *Override OpenAI Base URL* setting, but it may send requests from its own servers, which cannot reach an address on your computer and would see your prompts; check that your version calls the API from your computer before relying on it.

## Tokens

A token pays for one call, whatever the call costs; the rest of its value is not refunded. At the router's current keys the sizes are worth $0.002 (1000), $0.02 (10000, the default) and $0.20 (100000). The router holds the worst case for a call against the token's face value; if that is more it answers `402 token_value_too_low` and keeps the token unspent, and you can lower `max_tokens` or buy a larger size. Tokens expire at the end of the router's redemption window, one to two weeks after they are bought: `buy` prints the time and `status` shows the next expiry.

The tokens are Privacy Pass tokens (RFC 9578, type 0x0002) made with RSA blind signatures (RFC 9474), the ones `buyTokens` in `@anyroute/client/blind` buys.

## Files

`~/.anyroute` (or `$ANYROUTE_HOME`, mode 0700):

- `tokens.json` (mode 0600): the tokens you hold, and the ones sent without an answer. A token is a bearer credential; whoever reads it can spend it. It is never printed or logged. The file is replaced atomically and guarded by a lock file, so `buy` and a running `start` can share it. A file left readable by others is tightened to 0600 with a warning.
- `router.json` (mode 0600): the onion address last asked from the router, used only if the router cannot be asked next time.

The onion address is asked from the router's public name through Tor (a Tor exit connects, not you), checked as a version 3 onion address, and saved. `--onion` skips the question.

## Build and verify

```sh
bun packages/private/scripts/build.ts    # writes web/public/private.mjs and packages/private/dist/anyroute-private.mjs
shasum -a 256 web/public/private.mjs
```

The file is not minified and bundles `@cloudflare/blindrsa-ts` 0.4.6 (Apache-2.0) and `sjcl` 1.0.9 (BSD-2-Clause), which the client's blind-token code uses; their notices are at its top. The build gives the same bytes wherever it runs (with the Bun version the repository pins). A check in the repository rebuilds it and fails if the served file differs, and the documentation page reads the served file when the site is built, so the hash it shows is the hash of the file.

Checks, from the repository root: `bun test test/private-proxy.test.ts test/private-proxy-build.test.ts`. They run the program against a SOCKS5 server standing in for Tor and a server standing in for the router that verifies tokens with the router's own code. Type-check with `npm run typecheck` in this folder.

## Licence

Apache-2.0, see `LICENSE`. The SOCKS5 client in `src/socks.ts` is the one in `relay/`, with https support added.
