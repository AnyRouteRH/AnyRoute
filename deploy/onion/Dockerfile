# AnyRoute onion service: a Tor version 3 hidden service that forwards to the router over a private network.
#
# Two processes run in one small container, started and watched by entrypoint.sh:
#   tor      publishes the onion service and hands each connection to 127.0.0.1:18080
#   haproxy  listens there, marks every request with the shared secret in X-Anyroute-Onion (dropping any client-sent
#            copy and every header that names an address), forwards it to ONION_UPSTREAM, and keeps no log
#
# Build context is the repository root (like the other deploy images), and the base image is pinned by digest:
#
#   docker build -f deploy/onion/Dockerfile -t anyroute-onion .
#
# Packages are pinned to exact versions. Alpine keeps only the newest build of a package in each release, so when a
# security update lands the pin stops resolving and this build fails: bump the ARGs below (see README, "Updating").
#
# There is deliberately no VOLUME instruction: mount persistent storage at /var/lib/tor at run time. The hidden
# service's identity key lives in /var/lib/tor/hidden_service; losing it means losing the onion address.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

ARG TOR_VERSION=0.4.9.13-r0
ARG HAPROXY_VERSION=3.4.6-r0
ARG SU_EXEC_VERSION=0.3-r0

RUN apk add --no-cache "tor=${TOR_VERSION}" "haproxy=${HAPROXY_VERSION}" "su-exec=${SU_EXEC_VERSION}" \
 && rm -rf /etc/tor/torrc.sample /etc/haproxy/haproxy.cfg

COPY deploy/onion/torrc /etc/onion/torrc
COPY deploy/onion/haproxy.cfg /etc/onion/haproxy.cfg
COPY deploy/onion/entrypoint.sh /usr/local/bin/onion-entrypoint
RUN chmod 0644 /etc/onion/torrc /etc/onion/haproxy.cfg && chmod 0755 /usr/local/bin/onion-entrypoint

# The health listener: GET /healthz answers "ok" once Tor has bootstrapped, and nothing else. It listens on PORT on
# every interface so a platform health check can reach it, and it is connected to nothing.
ENV PORT=8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

# Starts as root only to give the mounted key directory to the tor user; tor and haproxy each run as their own
# unprivileged user (su-exec), and the container can also be run with --user tor if the directory is already theirs.
ENTRYPOINT ["/usr/local/bin/onion-entrypoint"]
