# Oblivious HTTP relay

A small, stateless relay for [Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458) (RFC 9458). It sits between clients and an Anyroute router's gateway so the router never sees a client's network address, and the relay never sees what the client asked.

```
client ── message/ohttp-req ──▶ relay ── message/ohttp-req ──▶ gateway (the router)
client ◀─ message/ohttp-res ── relay ◀─ message/ohttp-res ──── gateway
```

The client encrypts each request to the gateway's key before it leaves the client. The relay forwards those bytes and the answer, and cannot read either. The gateway decrypts, answers, and encrypts the answer to the client. Neither the relay nor the gateway sees both who is asking and what is asked.

That only holds if **the relay is run by someone other than the router's operator**. A relay run by the same party as the gateway hides nothing from it. The router publishes its relays at `GET /api/v1/relays`, marks the ones run by its own operator as not independent, and refuses the `unlinkable` lane through those. This README is for the independent operator.

## What the relay does

- Accepts `POST` of `message/ohttp-req` on one fixed path (`/relay` by default) and nothing else.
- Forwards the body, unchanged, to a gateway from its **allow-list** and returns the `message/ohttp-res`. The client names the gateway with `?gateway=<name>` (or its exact URL); with one gateway configured it can be omitted. Any other target is refused before a connection is made. Redirects are never followed.
- Reaches a gateway that is an **onion service** through a SOCKS5 proxy (a local Tor client) when `RELAY_SOCKS5_PROXY` is set. See [Reaching a gateway over Tor](#reaching-a-gateway-over-tor).
- Builds the forwarded request from scratch: it does not copy a single header, cookie, address or query string from the client's request. It sends `content-type`, `accept`, its own `user-agent`, and, if configured, `Authorization: Bearer <credential>` so the gateway can tell relay traffic from direct traffic.
- Rebuilds the response too: only the `message/ohttp-res` body reaches the client. When the gateway refuses before unwrapping (stale key, size, rate limit) it passes on the status code and a fixed message, never the gateway's headers or body.
- **Never logs a request, a body or a client address.** It writes one line at start-up (its own configuration: port, path, gateway names) and nothing while serving. What it keeps is counters, in memory, at `GET /metrics`: request, forwarded and refused counts by a fixed list of reasons, gateway response classes, bytes and requests in flight. They carry no client detail and reset on restart.
- Holds no state between requests, so several copies can run side by side.

It does not decrypt, inspect, pad or delay anything, and has no dependencies beyond the Bun runtime.

## Running one

You need a host you control, a DNS name, a TLS certificate, and the gateway operator's agreement to accept your relay.

### 1. Get a credential to the gateway operator

The gateway authenticates your relay so it can treat traffic that came through a relay differently from traffic that came straight to it. You choose the secret; the gateway operator only ever needs its hash.

```sh
key_id=example-relay-1                     # letters, digits, dots, dashes, underscores
secret=$(openssl rand -hex 32)             # keep this; it goes in your relay's configuration only
printf %s "$secret" | shasum -a 256        # this hash is what you send
```

Send the gateway operator: your **operator name**, the public **relay URL** clients will use, your **key_id**, and the **`secret_sha256`** (the hash above). Never send the secret itself. They add an entry to their `RELAY_OPERATORS` setting, and your relay then appears in their published relay list under your operator name. Your relay's credential is `key_id:secret`.

Do not use a name that is the gateway operator's own. Use the name of the party that runs this relay. Clients choose a relay by operator; independence is the whole point.

### 2. Configure

The relay reads its allow-list from the environment. Put the credential in a file rather than in a process listing if you can:

```sh
# gateways.json (mode 0600)
[{"name": "anyroute", "url": "https://<gateway host>/api/v1/ohttp/gateway", "credential": "example-relay-1:<secret>"}]
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_GATEWAYS` or `RELAY_GATEWAYS_FILE` | required | JSON array of `{name, url, credential?}`: the only gateways this relay will contact. URLs must be `https` (plain `http` only for localhost), with no credentials, query or fragment. |
| `RELAY_SOCKS5_PROXY` | unset | `socks5h://[user:password@]host:port`: a SOCKS5 proxy, normally a Tor client, that gateways whose URL is an onion service (`http://<56 characters>.onion/...`) are reached through. Required if any gateway is one; other gateways are still reached directly. The name is always sent to the proxy and never looked up by the relay, so `socks5://` means the same. |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `8080` | Listen address. The container image listens on `0.0.0.0:8080`. |
| `RELAY_PATH` | `/relay` | The one path that accepts requests. |
| `RELAY_MAX_BODY_BYTES` | 8 MiB | Largest request the relay carries (a response may be 64 KiB larger, for the gateway's padding). Match the gateway's `OHTTP_MAX_REQUEST_BYTES`. |
| `RELAY_TIMEOUT_MS` | 120000 | How long the gateway may take (model responses are slow). Up to 250000. |
| `RELAY_MAX_INFLIGHT` | 256 | Requests forwarded at once; more get a 503 rather than a queue. |
| `RELAY_METRICS` | `true` | Serve `/metrics`. Restrict it at your proxy if you prefer. |
| `RELAY_TLS_CERT_FILE`, `RELAY_TLS_KEY_FILE` | unset | Terminate TLS in the relay. Otherwise put a TLS-terminating proxy in front. |

### 3. Run it

Use the image by digest, so what runs is exactly what was built (the compose file in this directory sets the container up so nothing is written down):

```sh
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --log-driver none \
  -p 127.0.0.1:8080:8080 \
  -v "$PWD/gateways.json:/etc/relay/gateways.json:ro" -e RELAY_GATEWAYS_FILE=/etc/relay/gateways.json \
  <registry>/ohttp-relay@sha256:<digest>
```

Put TLS in front (or set the `RELAY_TLS_*` files). Requests and responses cross the network encrypted end to end to the gateway, but the client's connection to you must be HTTPS or a network observer sees who talks to you and when.

`GET /healthz` answers `ok`. A quick check from a client is the client helper in the router repository (`src/ohttp/client.ts`, `sendViaRelay`), which fetches the gateway key, encrypts a request and sends it through your URL.

### Reaching a gateway over Tor

A gateway operator can publish an onion address for its router (`GET /api/v1/status` carries it as `onion.address`; the gateway is then at `http://<address>/api/v1/ohttp/gateway`). A relay that reaches the gateway that way connects to it through the Tor network rather than from its own address: the gateway never sees the relay's network address, and the connection is encrypted and authenticated end to end by the onion service itself, so it uses plain `http://`. The relay's credential still goes in `Authorization` as before; the gateway operator still lists your relay, and its `key_id`, in `RELAY_OPERATORS`.

1. Run a Tor client next to the relay and let it listen for SOCKS on an address only the relay can reach, for example in `torrc`:

   ```
   SocksPort 127.0.0.1:9050
   ClientOnly 1
   SafeLogging 1
   Log notice stderr
   ```

   In containers, run it as its own container on a private network shared with the relay and point the relay at it by name (`socks5h://tor:9050`); never publish the SOCKS port.
2. Put the onion gateway in the allow-list and give the relay the proxy:

   ```sh
   RELAY_SOCKS5_PROXY=socks5h://127.0.0.1:9050
   RELAY_GATEWAYS='[{"name":"anyroute-onion","url":"http://<56 characters>.onion/api/v1/ohttp/gateway","credential":"example-relay-1:<secret>"}]'
   ```

   The relay refuses to start if a gateway is an onion service and no proxy is set, if the URL is `https://` (there is no certificate to check; the onion connection is the encryption), or if the name is not a version 3 onion address. A proxy URL with a user name and password makes Tor use a separate circuit per credential pair; without one Tor already keeps different destinations apart.
3. Allow for the first connection: building a circuit to an onion service takes seconds and sometimes tens of seconds, so keep `RELAY_TIMEOUT_MS` at its default or higher.

How it behaves: the relay hands the onion name to the proxy as a name and never resolves it (no DNS lookup on this host), opens one tunnel per request, sends the same request it would send to any gateway, and closes the tunnel afterwards. A proxy that cannot reach the onion service (Tor not running, service down, no circuit) gives the client a 502 and adds to `relay_gateway_unreachable_total{kind="proxy"}`; a gateway that answers too slowly gives a 504 as usual. Nothing about the tunnel or the proxy's reply is logged or passed to the client. Gateways that are not onion services keep going out directly, so one relay can serve both kinds.

Tor hides the relay from the gateway; it does not change what a relay and a gateway that cooperate can do, and the client's connection to the relay is a separate matter (a relay can itself be offered as an onion service by putting a Tor onion service in front of it, with access logs off as above).

### Build it yourself

The image builds reproducibly from a pinned base image and the committed lockfile. Build it, compare its digest with the one the project publishes, and run yours:

```sh
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
docker buildx build --build-arg SOURCE_DATE_EPOCH \
  --output type=image,name=<registry>/ohttp-relay,push=true,rewrite-timestamp=true relay/
```

## What you must not do

The privacy of the people using your relay is only as good as what you keep.

- **Turn off access logs** in whatever terminates TLS or proxies to the relay (web server, load balancer, CDN, cloud provider request logs). Those logs hold client addresses and timings, which is exactly what the relay exists to keep from the gateway; they are also what a court order or a breach would reach. Keep counters, not logs.
- Do not record, sample or mirror request bodies, and do not attach identifiers (addresses, cookies, user IDs, tags) to what you forward. The relay as shipped does none of this; do not patch it to.
- Do not run the gateway (or anything the gateway operator controls) next to the relay, and do not share logs, metrics or captures with the gateway operator. If you cooperate, the protection is gone.
- Do not delay or reorder requests, or treat some clients differently from others (for example blocking one), without telling clients: it shrinks the set of people a request could have come from. A relay that carries more people gives each of them more cover.
- Keep the secret out of version control and shell history, and rotate it (a new `key_id`, a new hash to the gateway operator) if it may have leaked.

## What the relay cannot do

It cannot read or alter requests or responses (they are encrypted to the gateway), but it can refuse to forward them and it sees when a request happens, how large it is, and which network address sent it. A relay and a gateway that compare notes can link a request to a client by timing and size. Responses from the Anyroute gateway are padded to a multiple of 256 bytes; clients can pad requests. Oblivious HTTP protects against a curious gateway, not against a relay and a gateway that collude, and not against an observer of both sides at once.

## Tests

```sh
bun install
bun test        # a mock gateway on a real socket; header stripping, allow-list, limits, no logging, packaging
bun run typecheck
```
