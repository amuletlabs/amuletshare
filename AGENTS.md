# Agent guide

This repository is designed for work by both people and coding agents. Keep changes small, reviewable, and easy for the next contributor to understand.

## Product architecture

- `src/` contains the Cloudflare Worker, HTTP routes, services, and scheduled cleanup.
- `public/` contains the browser UI and agent-facing `llms.txt` documentation.
- `migrations/` contains ordered D1/SQLite migrations.
- `test/` contains Worker integration, boundary, and browser tests.
- `API.md` is the complete external API contract.

The production path uses a private R2 bucket for file bytes and D1 for metadata. Wrangler's local state is only a development artifact and must never be committed.

## Working agreements

1. Use `pnpm`; keep `pnpm-lock.yaml` in sync with dependency changes.
2. Do not commit secrets, `.dev.vars`, `.env` files, Wrangler state, test output, or generated dependencies.
3. Add new migrations instead of rewriting migrations that may already have been applied.
4. Keep the implementation, `API.md`, and `public/llms.txt` aligned when the public API changes.
5. Preserve file-size, multipart, password, retention, and local-only inspector boundaries unless a change explicitly updates the product contract and tests.
6. Do not deploy, migrate production data, or change Cloudflare resources unless the task explicitly authorizes it.
7. Explain non-obvious decisions in the pull request; avoid unrelated cleanup in the same change.

## Verification

Run before handing off a change:

```bash
pnpm typecheck
pnpm test
```

Also run `pnpm test:e2e` for browser-facing changes and `pnpm test:smoke` for upload, storage, or API-flow changes. The smoke suite creates large local fixtures, so allow enough disk space and time.
