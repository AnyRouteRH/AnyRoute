# Onion service

A Tor version 3 onion service in front of the router. A client that reaches the router at its `.onion` address connects through the Tor network, so the router (and the platform it runs on) never sees the client's network address, and nobody between the client and the onion service can read or alter the traffic. It needs no trust in any relay: Tor's own circuits carry the connection.

```
client ── Tor circuit ──▶ tor ──▶ haproxy ── private network ──▶ router
                          └────── this container ──────┘
```

Two processes run in one small container (Alpine, about 15 MB, Tor and HAProxy at exact versions, base image pinned by digest). `tor` publishes the service and hands each connection to `haproxy` on the container's loopback. `haproxy` sets `X-Anyroute-Onion: <secret>` on the request, removes any copy of that header a client sent and every header that names an address (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, and similar), and forwards to `ONION_UPSTREAM`. It writes no log of any kind. Tor is configured with `SafeLogging` and logs only its own start-up.

## What the router does with it

Set `ONION_ADDRESS` and `ONION_PROXY_SECRET` on the router (below). Then:

- `GET /api/v1/status` publishes `onion: { address, url }`, the docs page shows it, and the site's HTML pages carry an `Onion-Location` header so Tor Browser offers the onion twin.
- A request that carries the secret is an onion request; the header alone means nothing. Onion requests have no client address, and the address the router sees is the proxy's, the same for every client. So the router does not key any per-address rate limit by it. Calls with an API key are limited per key, as always. Calls without a key (unkeyed chat and embeddings, new keys, wallet sign-in challenges, the paymaster, the gateway's direct limit) count against one bucket per limit that all onion clients share, `ONION_POOL_MULTIPLIER` (default 10) times what one address gets and separate from every real address. One abusive onion client can therefore use up the shared bucket for other unkeyed onion callers, but never for clearnet callers, and not for anyone with a key. To have a quota of your own over Tor, use an API key or a blind token.

What Tor does not hide: whatever you put in the request. An API key, a wallet signature or a prompt identifies you or your account exactly as it does on the clearnet. For payment without an account link use blind tokens.

### The unlinkable lane over Tor (off by default)

With `UNLINKABLE_VIA_ONION=true` on the router, lane `unlinkable` is also served to onion requests: a request that carries the proxy's secret, names the lane (`provider.lane` or `X-Anyroute-Lane`) and is paid with a blind token (`Authorization: PrivateToken`) is served by attested providers only, streamed or not, and its receipt and `X-Anyroute-Lane` say `unlinkable`. An API key, a wallet or a per-call payment is refused with `lane_requires_anonymous_auth`, as on the relay path; a request that names no lane stays on `public`. Tor takes the place of the independent Oblivious HTTP relay: the client's address never reaches this container or the router, because Tor's rendezvous circuit does not carry it, so it does not matter that the onion service is run by the router's own operator. The router still terminates TLS on this lane and sees the request, exactly as it does on the relay path.

The router refuses to start with the flag on unless `ONION_ADDRESS`, `ONION_PROXY_SECRET` and `ANYROUTE_FEATURE_BLIND=true` are all set; the flag does not need or change `OHTTP_ENABLED`, and does not relax its relay-operator minimum. `GET /api/v1/status` then shows `lanes.unlinkable.available: true` with `via: ["onion"]` (`["ohttp", "onion"]` when both paths are on).

The secret is the whole of the check that a request came through this service, so keep it as private as a key: a copy of it would let a clearnet client be taken for an onion one. HAProxy deletes any `X-Anyroute-Onion` a client sends, the router compares the value in constant time, and on onion requests the router deletes the address headers again before any route runs and keys no limit by an address.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `ONION_UPSTREAM` | yes | The router's private URL: `http://host:port`, plain http, no path. On Railway, `http://api.railway.internal:8787` (the service name and the router's port). Resolved again as its answers expire, so a redeployed router is found. |
| `ONION_PROXY_SECRET` | yes | One secret of 32 to 200 characters (`A-Z a-z 0-9 . _ ~ + / = -`), for example `openssl rand -hex 32`. The router's `ONION_PROXY_SECRET` must contain it. |
| `PORT` | no (8081) | The health listener, on every interface. `GET /healthz` answers `ok` once Tor has bootstrapped; everything else is `404`. It is connected to nothing and exposes no address, upstream or version. Not 18080, which Tor uses inside the container. |
| `ONION_SINGLE_HOP` | no (false) | `true` makes this a single onion service: lower latency and less load on the network, but the service no longer hides where it runs. Clients stay anonymous. Use it only where the router's location is public anyway. Once a directory has been used in one mode, Tor refuses to start it in the other. |
| `ONION_BOOTSTRAP_TIMEOUT` | no (300) | Seconds to wait for Tor to finish starting before the container exits (and the platform restarts it). |

**Storage.** Mount a persistent volume at `/var/lib/tor`. The service's identity is the key in `/var/lib/tor/hidden_service/hs_ed25519_secret_key`: whoever holds it can be the service, and if it is lost the address is lost with it (the address is derived from the key and cannot be recovered). Everything else in the volume (Tor's cached directory information, about 40 MB) is disposable, but keeping it makes restarts quick. Back the three files in `hidden_service/` up somewhere private, offline or in a password manager, never in this repository or in a variable. To use a key you generated earlier (a vanity address, or a move from another host), put `hs_ed25519_secret_key`, `hs_ed25519_public_key` and `hostname` in that directory before the first start; the container fixes ownership and permissions.

Run exactly one copy. Two Tor instances with the same key overwrite each other's descriptors and the address flaps.

## Deploy on Railway

The service is described by `deploy/railway/onion.railway.json` (see `deploy/railway/README.md` for the other services and the note on Config as Code). Source root stays the repository root, because the image is built from `deploy/onion/`.

1. **Shared secret.** Generate one secret, `openssl rand -hex 32`, and add it as a shared variable `ONION_PROXY_SECRET` for the environment, so the `onion` and `api` services reference the same value.
2. **New service** named `onion` from this repository. Point it at the config file `deploy/railway/onion.railway.json`, or, if the dashboard does not offer that for a new service, set the same values by hand: variable `RAILWAY_DOCKERFILE_PATH=deploy/onion/Dockerfile`, health check path `/healthz` (timeout 300 s), restart policy on failure (10 retries), 1 replica.
3. **Volume.** Add a volume to the service mounted at `/var/lib/tor` (1 GB is plenty).
4. **Variables** on `onion`: `ONION_UPSTREAM=http://api.railway.internal:8787` (adjust the service name and port), `ONION_PROXY_SECRET=${{shared.ONION_PROXY_SECRET}}`, `PORT=8081`. Give it no public domain and no TCP proxy: it only makes outbound connections to Tor and to the router.
5. **Deploy.** The logs show Tor starting, then `onion: onion address: <56 characters>.onion`, then `onion: ready`. The deployment turns healthy at that point (a minute or two on a cold start). A service with a volume stops the old deployment before starting the new one, so a redeploy is a short outage; after it, allow a few minutes for Tor clients to find the new descriptor.
6. **Tell the router.** On the `api` service set `ONION_ADDRESS=<that address>` and `ONION_PROXY_SECRET=${{shared.ONION_PROXY_SECRET}}`, then redeploy it. The router must be reachable on Railway's private network: in an environment whose private network is IPv6 only, also set `HOST=::` on `api`. Check `curl https://<router>/api/v1/status` shows `data.onion`.
7. **Check from Tor Browser.** Open `http://<address>/api/v1/status` and the site's front page, and load the clearnet site to see the `.onion available` prompt.
   To serve lane `unlinkable` over Tor as well, set `UNLINKABLE_VIA_ONION=true` on `api` (it also needs `ANYROUTE_FEATURE_BLIND=true` there) and redeploy it; nothing changes on `onion`. `data.lanes.unlinkable` in the status then reads `available: true, via: ["onion"]`.
8. **Back up the key.** `railway ssh --service onion`, then print `/var/lib/tor/hidden_service/hs_ed25519_secret_key` (for example `base64 < …`), and store it privately.

Rotating the secret without a gap: add the new value to the router's `ONION_PROXY_SECRET` as a comma list (`new,old`), redeploy `api`, change the `onion` variable to `new`, then drop `old` from the router.

## Run it yourself

```sh
docker build -f deploy/onion/Dockerfile -t anyroute-onion .
docker run -d --name anyroute-onion \
  -v anyroute-onion-data:/var/lib/tor \
  -e ONION_UPSTREAM=http://router:8787 -e ONION_PROXY_SECRET="$(cat proxy-secret)" \
  --network <network shared with the router> anyroute-onion
docker exec anyroute-onion cat /var/lib/tor/hidden_service/hostname   # the address, once it is ready
```

The container publishes no port: the only way in is Tor. To try it without a router, point `ONION_UPSTREAM` at any HTTP server. `docker ps` shows it healthy once Tor has bootstrapped.

## What is and is not logged

Nothing about a request or a client is logged by this container: HAProxy has no log configured (no access log, no error log, no stats socket) and Tor does not log the traffic of a hidden service. The container prints its own state (`starting tor`, the bootstrap progress, the onion address, `ready`) and errors. The router's own logs are governed by the router; it records no client address for onion requests, since it has none.

## Updating

The Alpine package repository keeps only the newest build of each package per release, so when Tor or HAProxy is updated there the pinned version in the Dockerfile stops resolving and the build fails. That is the prompt to update: get the current versions and the base image digest, change the `ARG`s and the `FROM` line, rebuild, and run `bun test test/onion-deploy.test.ts`.

```sh
docker run --rm alpine:3.24 sh -c 'apk update -q && apk policy tor haproxy su-exec'
docker buildx imagetools inspect alpine:3.24 | head -3   # the digest for the FROM line
```

Watch Tor security advisories: a Tor update is worth a redeploy the same day.
