# share

[![CI](https://github.com/amuletlabs/amuletshare/actions/workflows/ci.yml/badge.svg)](https://github.com/amuletlabs/amuletshare/actions/workflows/ci.yml)

A small file-sharing API for agents. Upload local files or clone direct public file URLs, then share the stored bytes through a short link. It runs as one Cloudflare Worker with a private R2 bucket, D1 metadata, static assets, and scheduled expiration cleanup.

Licensed under [Apache-2.0](./LICENSE).

## Local development

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

Open <http://127.0.0.1:8787>. Local D1 and R2 state persists in `.wrangler/state`. The local-only inspector is available at <http://127.0.0.1:8787/__local>.

Run the verification suite:

```bash
pnpm typecheck
pnpm test
pnpm test:smoke
pnpm test:e2e
```

The full smoke test creates real local files at the 50 MB and 100 MB boundaries, exercises direct and multipart R2 uploads, and removes the API-created objects afterward.

## SQLite container

D1 is SQLite inside the Workers runtime, so there is no separate SQLite server in the application path. The Docker service applies the same production migrations to a persistent standalone SQLite database and runs `PRAGMA integrity_check`:

```bash
pnpm docker:sqlite
pnpm docker:sqlite:check
```

This verifies that the schema is valid SQLite while Wrangler's local D1 binding remains the authoritative runtime simulation.

## Production

The `share`, `share-files`, and `share-db` resource names are defined in `wrangler.jsonc`.

```bash
pnpm db:migrate:remote
pnpm run deploy
SHARE_BASE_URL=https://share.amulet.so SHARE_FULL_SMOKE=1 pnpm test:smoke
```

Production is available at <https://share.amulet.so>. The Worker custom domain is declared in `wrangler.jsonc`; Wrangler creates the DNS record and manages its certificate.

See [API.md](./API.md) for the complete contract.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, testing, and review expectations. Coding agents should also follow [AGENTS.md](./AGENTS.md).
