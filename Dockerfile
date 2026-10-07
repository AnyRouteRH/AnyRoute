# The data inventory behind the website's "What we keep" page: generated from the schema and the descriptions in src/privacy by the
# code in this image, so the page, /keep/inventory.json and the hash the router logs cannot disagree with the schema.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS inventory
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --minimum-release-age 604800
COPY src ./src
COPY scripts/gen-inventory.ts ./scripts/gen-inventory.ts
RUN bun scripts/gen-inventory.ts --out /out/inventory.generated.json

# Website: static Next.js export, served by the router at /.
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS web
WORKDIR /web
RUN npm install -g pnpm@11.19.0
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/next.config.mjs ./
COPY web/app ./app
COPY --from=inventory /out/inventory.generated.json ./app/keep/inventory.generated.json
# The commit shown on /keep. The image build cannot see git: pass --build-arg ANYROUTE_BUILD_COMMIT=<40-hex commit> (or set it as a
# service variable); without it the page says the build did not record a commit.
ARG ANYROUTE_BUILD_COMMIT=""
ENV ANYROUTE_BUILD_COMMIT=$ANYROUTE_BUILD_COMMIT
# Public settings for /zkapi/. Pass as build arguments (or service variables); without them the page stays disabled.
ARG NEXT_PUBLIC_ZKAPI_ENABLED="false"
ARG NEXT_PUBLIC_ZKAPI_MANIFEST_URL=""
ARG NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256=""
ENV NEXT_PUBLIC_ZKAPI_ENABLED=$NEXT_PUBLIC_ZKAPI_ENABLED NEXT_PUBLIC_ZKAPI_MANIFEST_URL=$NEXT_PUBLIC_ZKAPI_MANIFEST_URL NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256=$NEXT_PUBLIC_ZKAPI_MANIFEST_SHA256
COPY web/components ./components
COPY web/lib ./lib
COPY web/public ./public
COPY spec /spec
COPY WHITEPAPER.md /WHITEPAPER.md
# The build writes the installable app's service worker from the exported shell.
COPY web/scripts/build-pwa.mjs ./scripts/build-pwa.mjs
# C126: build-pwa imports the offline dark/light palette builder.
COPY web/scripts/build-theme.mjs ./scripts/build-theme.mjs
# The build first checks public wording (changelog, whitepaper) with these build-time-only scripts.
COPY web/scripts/check-public-wording.mjs web/scripts/whitepaper-wording.mjs ./scripts/
RUN pnpm build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --minimum-release-age 604800

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
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
