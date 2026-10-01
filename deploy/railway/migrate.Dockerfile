FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY scripts/migrate.ts ./scripts/migrate.ts
COPY src/db ./src/db
COPY src/network/schema.ts ./src/network/schema.ts
COPY src/network/payout-schema.ts ./src/network/payout-schema.ts
COPY src/network/bond-schema.ts ./src/network/bond-schema.ts
COPY src/agents/profile-schema.ts ./src/agents/profile-schema.ts
COPY src/agents/schema.ts ./src/agents/schema.ts
COPY src/agents/approval-schema.ts ./src/agents/approval-schema.ts
COPY src/agents/ledger-schema.ts ./src/agents/ledger-schema.ts
COPY src/lib/util.ts ./src/lib/util.ts
COPY src/providers/headers.ts ./src/providers/headers.ts
COPY drizzle ./drizzle

USER bun
CMD ["bun", "scripts/migrate.ts"]
