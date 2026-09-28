FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/init-upstream.ts ./scripts/init-upstream.ts
USER bun
CMD ["bun", "scripts/init-upstream.ts"]
