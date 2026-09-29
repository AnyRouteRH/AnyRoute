# Hugging Face model-card badge

Hugging Face model cards have no field for third-party inference routers, so the listing is a badge plus a short "Run it on Anyroute" section in the card's `README.md`.

`badge.md` is the snippet to paste. Replace `<model id>` with the Anyroute id (usually the same `author/model` as on Hugging Face; check `GET /api/v1/models`). Keep the attested badge only for models with `attested_available: true`; delete it (and its comment) otherwise.

The badge renders as `Run on | Anyroute` in Anyroute's ink and signal green:

```markdown
[![Run on Anyroute](https://img.shields.io/badge/Run%20on-Anyroute-1fe15a?labelColor=0b0c0b)](https://api-production-70da.up.railway.app/models)
```

## For model authors

Anyroute pays a model's creator a royalty on calls to it. To claim it: `POST /api/v1/creators/claims` with the model and a payout address returns a challenge; commit it to the file the response names on the main branch of the Hugging Face repo, then `POST /api/v1/creators/claims/<id>/verify`. Details in the docs under "Open-weights variants, and paying their creators" (`/docs#lane`).

## Submit (not done yet)

Nothing is sent automatically. Per model: open it on Hugging Face, **Community > New pull request**, edit `README.md`, paste `badge.md` under the usage section, and describe the change in one line. Start with models whose authors have claimed their royalty, since they are the ones most likely to merge it.
