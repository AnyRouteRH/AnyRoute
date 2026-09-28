# Website: static Next.js export, served by the router at /.
FROM node:22-slim AS web
WORKDIR /web
RUN npm install -g pnpm@11.19.0
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/next.config.mjs ./
COPY web/app ./app
COPY web/components ./components
COPY web/lib ./lib
COPY web/public ./public
RUN pnpm build

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.3
WORKDIR /app
ENV ANYROUTE_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY config ./config
COPY --from=web /web/out ./web/out
USER bun
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:8787/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/index.ts"]
