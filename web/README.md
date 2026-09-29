# Anyroute website

The landing page, live model catalog, API docs and dashboard for the Anyroute router. It is a static Next.js
export; the router serves `out/` at `/`, on the same origin as `/api/v1`.

```sh
pnpm install --frozen-lockfile
pnpm dev        # http://127.0.0.1:4280
pnpm test       # node:test for the API adapter and the sample workspace
pnpm build      # static export to out/
pnpm preview    # serve out/ on http://127.0.0.1:4281
```

From the repository root, `bun run launch` builds this site when its sources change and starts it with a local
chain, mock providers and the router.

## Layout

- `app/`: routes (`/`, `/models`, `/arena`, `/docs`, `/dashboard`, `/case-study`, `/legal/*`) and the design system in `globals.css`.
- `components/`: landing sections, the dashboard and model catalog, shared UI (`UI.jsx`) and the vector identity (`Logo.jsx`).
- `lib/api.js`: live API client (fetch, streaming, key storage in the browser). `lib/wallet.js`: EIP-1193 helpers that sign the router's unsigned transactions. `lib/arena.js`: the Model Arena's link encoding, badge and lane-runner logic. `lib/demo.js`: fixtures for the opt-in sample workspace (`?demo=1`).
- `public/brand/`: logo, mark and banner.

Set `NEXT_PUBLIC_ANYROUTE_API_URL` at build time to host the site apart from the router. Nothing secret is bundled.

## Motion

Canvases (the hero route field and the footer signal curtain) pause off-screen and when the tab is hidden, and render
a single static frame under `prefers-reduced-motion`. Scroll reveals, count-ups and progress rails come from
`MotionManager` in `components/UI.jsx`.

## Type

[Host Grotesk](https://github.com/Element-Type/HostGrotesk) and [Martian Mono](https://github.com/evilmartians/mono),
both under the SIL Open Font License 1.1, self-hosted through `@fontsource-variable`.
