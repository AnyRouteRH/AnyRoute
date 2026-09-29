# Scheduled encrypted off-host PostgreSQL backup: `bun scripts/backup-offsite.ts` runs once and exits.
# pg_dump must be the database's major version (or newer). The default client is PostgreSQL 16; for a
# PostgreSQL 17/18 database set the POSTGRES_CLIENT_IMAGE build argument to that major's reviewed
# postgres:<major>-bookworm@sha256 image (see deploy/railway/README.md). Every input is pinned.
ARG POSTGRES_CLIENT_IMAGE=postgres:16.15-bookworm@sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS tools
ARG TARGETARCH
# age v1.3.1 release archives, verified against the SHA-256 digests published with the release.
ARG AGE_VERSION=v1.3.1
ARG AGE_SHA256_AMD64=bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377
ARG AGE_SHA256_ARM64=c6878a324421b69e3e20b00ba17c04bc5c6dab0030cfe55bf8f68fa8d9e9093a
WORKDIR /tools
RUN set -eu; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in amd64) sum="$AGE_SHA256_AMD64" ;; arm64) sum="$AGE_SHA256_ARM64" ;; *) echo "unsupported architecture $arch" >&2; exit 1 ;; esac; \
    bun -e 'const r = await fetch(process.argv[1]); if (!r.ok) process.exit(1); await Bun.write(process.argv[2], r);' \
      "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${arch}.tar.gz" age.tar.gz; \
    echo "${sum}  age.tar.gz" | sha256sum -c -; \
    tar -xzf age.tar.gz; \
    install -m 0755 age/age /tools/age

FROM ${POSTGRES_CLIENT_IMAGE}
COPY --from=tools /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tools /tools/age /usr/local/bin/age
WORKDIR /opt/anyroute
COPY scripts/backup-db.sh scripts/backup-offsite.ts ./scripts/
RUN set -eu; for tool in bash bun age pg_dump psql sha256sum; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }; done; \
    bun --version >/dev/null; age --version >/dev/null; pg_dump --version
# The postgres image's unprivileged user; the job needs only /tmp and outbound network access.
USER postgres
CMD ["bun", "--no-env-file", "scripts/backup-offsite.ts"]
