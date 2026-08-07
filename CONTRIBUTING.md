# Contributing

Thanks for helping grow share. Bug reports, focused feature proposals, documentation improvements, and pull requests are welcome.

## Set up locally

Requirements:

- A current Node.js LTS release
- pnpm
- Docker only for the optional standalone SQLite schema check

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

The app will be available at <http://127.0.0.1:8787>. Local D1 and R2 data is stored under the ignored `.wrangler/` directory.

## Make a change

1. Create a branch from `main`.
2. Keep the change focused and add or update tests for behavior changes.
3. Update `API.md` and `public/llms.txt` when the public API changes.
4. Run the relevant verification commands from `AGENTS.md`.
5. Open a pull request that explains the problem, the approach, and how the result was tested.

Please do not include credentials, production data, generated dependencies, local databases, or uploaded test files in commits.

## Report security issues

Do not open a public issue for a vulnerability that could expose uploaded files, passwords, infrastructure, or user data. Contact the maintainers privately through the repository owner's established security channel instead.
