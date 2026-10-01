FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
COPY sidecar/src/agent ./src/agent
COPY sidecar/src/attestation/dstack.ts sidecar/src/attestation/types.ts sidecar/src/attestation/tdx-quote.ts ./src/attestation/
COPY sidecar/src/util.ts sidecar/src/tls.ts ./src/
ENTRYPOINT ["bun", "src/agent/main.ts"]
CMD ["serve"]
