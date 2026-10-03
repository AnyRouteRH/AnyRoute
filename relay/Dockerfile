# Anyroute Oblivious HTTP relay image.
#
# Reproducibility: the base image is pinned by digest, dependencies come from the committed lockfile
# (`--frozen-lockfile --ignore-scripts`), nothing is fetched at run time, and every file's mtime and mode is
# normalised from SOURCE_DATE_EPOCH. Build with a fixed epoch and timestamp rewriting so two builds of the same
# commit give the same image digest:
#
#   SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
#   docker buildx build \
#     --build-arg SOURCE_DATE_EPOCH \
#     --output type=image,name=<registry>/ohttp-relay,push=true,rewrite-timestamp=true \
#     relay/
#
# Then run it by digest (image: <registry>/ohttp-relay@sha256:...), so what runs is exactly what was built.

ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --minimum-release-age 604800

FROM ${BUN_IMAGE} AS stage
ARG SOURCE_DATE_EPOCH=0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Normalise metadata so the layer content does not depend on when or where the build ran.
RUN find /app -type d -exec chmod 0755 {} + \
 && find /app -type f -exec chmod 0644 {} + \
 && find /app -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM ${BUN_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8080
COPY --from=stage /app /app
USER bun
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=6s --start-period=10s --retries=3 CMD ["bun", "src/main.ts", "healthcheck"]
ENTRYPOINT ["bun", "src/main.ts"]
CMD ["serve"]
