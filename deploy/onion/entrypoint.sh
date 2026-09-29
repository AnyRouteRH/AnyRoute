#!/bin/sh
# Starts and watches the two processes of the onion service: Tor, and the HAProxy that forwards to the router.
# Configuration comes from the environment (see README.md). Nothing in here logs a request or a client.
set -eu
umask 077

say() { printf 'onion: %s\n' "$*"; }
die() { printf 'onion: %s\n' "$*" >&2; exit 64; }

# ---- 1. Configuration -------------------------------------------------------------------------------------------

[ -n "${ONION_UPSTREAM:-}" ] || die "ONION_UPSTREAM is required: the router's private URL, for example http://api.railway.internal:8787"
parsed=$(printf '%s' "$ONION_UPSTREAM" | sed -nE 's#^http://([A-Za-z0-9._-]{1,253})(:([0-9]{1,5}))?/?$#\1 \3#p')
[ -n "$parsed" ] || die "ONION_UPSTREAM must look like http://host:port (plain http on a private network; no path, credentials or https)"
# shellcheck disable=SC2086
set -- $parsed
ONION_UPSTREAM_HOST=$1
ONION_UPSTREAM_PORT=${2:-80}
[ "$ONION_UPSTREAM_PORT" -ge 1 ] && [ "$ONION_UPSTREAM_PORT" -le 65535 ] || die "ONION_UPSTREAM has an invalid port"

# The secret the router checks (its ONION_PROXY_SECRET). Header-safe characters only, so it can be written into the config.
[ -n "${ONION_PROXY_SECRET:-}" ] || die "ONION_PROXY_SECRET is required: the router's ONION_PROXY_SECRET, for example the output of: openssl rand -hex 32"
printf '%s' "$ONION_PROXY_SECRET" | grep -Eq '^[A-Za-z0-9._~+/=-]{32,200}$' || die "ONION_PROXY_SECRET must be one secret of 32 to 200 characters from A-Z a-z 0-9 . _ ~ + / = -"

HEALTH_PORT=${PORT:-8081}
case "$HEALTH_PORT" in ''|*[!0-9]*) die "PORT must be a number";; esac
[ "$HEALTH_PORT" -ge 1024 ] && [ "$HEALTH_PORT" -le 65535 ] && [ "$HEALTH_PORT" -ne 18080 ] || die "PORT must be between 1024 and 65535 and not 18080 (Tor hands connections to 18080 inside the container)"
# Listen on IPv4 and IPv6 where the container has IPv6 (private networks may be IPv6 only), otherwise IPv4.
if [ -e /proc/net/if_inet6 ]; then HEALTH_BIND=":::$HEALTH_PORT"; else HEALTH_BIND="0.0.0.0:$HEALTH_PORT"; fi

case "${ONION_SINGLE_HOP:-false}" in
  true|1|yes) SINGLE_HOP=1 ;;
  false|0|no|'') SINGLE_HOP=0 ;;
  *) die "ONION_SINGLE_HOP must be true or false" ;;
esac

export ONION_UPSTREAM_HOST ONION_UPSTREAM_PORT ONION_PROXY_SECRET HEALTH_BIND

# ---- 2. Directories and users -----------------------------------------------------------------------------------

TOR_DATA=/var/lib/tor
HS_DIR=$TOR_DATA/hidden_service
RUN_DIR=/tmp/onion
NOTICE_LOG=$RUN_DIR/notices.log

mkdir -p "$TOR_DATA" "$RUN_DIR"
if [ "$(id -u)" = 0 ]; then
  # A mounted volume arrives owned by root: hand the key directory to tor, and tighten what Tor insists on.
  mkdir -p "$HS_DIR"
  chown -R tor:tor "$TOR_DATA" "$RUN_DIR"
  AS_TOR="su-exec tor:tor"
  AS_PROXY="su-exec haproxy:haproxy"
else
  mkdir -p "$HS_DIR"
  AS_TOR=""
  AS_PROXY=""
fi
chmod 700 "$TOR_DATA" "$HS_DIR"
find "$HS_DIR" -type d -exec chmod 700 {} +
find "$HS_DIR" -type f -exec chmod 600 {} +

sed -e "s#@@NOTICE_LOG@@#$NOTICE_LOG#" /etc/onion/torrc > "$RUN_DIR/torrc"
if [ "$SINGLE_HOP" = 1 ]; then
  # A single onion service: faster, but the service does not hide where it runs (the router's location is public anyway).
  # Clients are still anonymous. Off by default.
  printf 'HiddenServiceNonAnonymousMode 1\nHiddenServiceSingleHopMode 1\n' >> "$RUN_DIR/torrc"
fi
[ "$(id -u)" != 0 ] || chown tor:tor "$RUN_DIR/torrc"

# Refuse to start on a configuration HAProxy would reject, before waiting for Tor.
$AS_PROXY haproxy -c -q -f /etc/onion/haproxy.cfg || die "the proxy configuration was rejected (check ONION_UPSTREAM)"

# ---- 3. Run -----------------------------------------------------------------------------------------------------

TOR_PID=""
PROXY_PID=""
stop_all() {
  [ -z "$PROXY_PID" ] || kill "$PROXY_PID" 2>/dev/null || true
  [ -z "$TOR_PID" ] || kill "$TOR_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap 'stop_all; exit 0' TERM INT

# sleep in the background and wait for it, so a signal is handled at once instead of after the sleep.
nap() { sleep "$1" & wait $! 2>/dev/null || true; }

say "starting tor (single onion service: $([ "$SINGLE_HOP" = 1 ] && echo yes || echo no))"
# shellcheck disable=SC2086
$AS_TOR tor -f "$RUN_DIR/torrc" &
TOR_PID=$!

waited=0
until grep -q 'Bootstrapped 100%' "$NOTICE_LOG" 2>/dev/null; do
  kill -0 "$TOR_PID" 2>/dev/null || die "tor exited before it finished starting; see the lines above"
  waited=$((waited + 1))
  [ "$waited" -le "${ONION_BOOTSTRAP_TIMEOUT:-300}" ] || { stop_all; die "tor did not finish starting within ${ONION_BOOTSTRAP_TIMEOUT:-300} seconds"; }
  nap 1
done

waited=0
until [ -s "$HS_DIR/hostname" ]; do
  kill -0 "$TOR_PID" 2>/dev/null || die "tor exited before it published the onion service"
  waited=$((waited + 1))
  [ "$waited" -le 30 ] || { stop_all; die "tor did not create the onion service"; }
  nap 1
done
say "onion address: $(cat "$HS_DIR/hostname") (set it as ONION_ADDRESS on the router)"

# The proxy starts only now, so the health listener (which lives in it) answers only when Tor is up.
# shellcheck disable=SC2086
$AS_PROXY haproxy -f /etc/onion/haproxy.cfg &
PROXY_PID=$!
say "ready"

# If either process stops the container stops too, and the platform restarts it.
while kill -0 "$TOR_PID" 2>/dev/null && kill -0 "$PROXY_PID" 2>/dev/null; do nap 2; done
kill -0 "$TOR_PID" 2>/dev/null || say "tor stopped"
kill -0 "$PROXY_PID" 2>/dev/null || say "the proxy stopped"
stop_all
exit 1
