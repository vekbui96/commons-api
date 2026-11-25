# CLAUDE.md

Commons API: the backend for Commons. The front end is a separate repo,
`vekbui96/commons` (`D:\projects\commons`). Architecture and the add-an-app
steps are in `README.md`; the shared contract is `docs/api-contract.md`.

## Rules

- **One entry point, apps plug in.** `src/index.ts` is the only process and
  port. An app's backend is `src/apps/<id>/routes.ts` exporting a router
  factory, auto-mounted under `/api/apps/<id>/`. Shared things (health, db,
  per-app KV, later auth) stay in `src/core/`. Never start a second server or
  port for an app.
- Storage is the built-in `node:sqlite`. **No better-sqlite3** or other native
  modules: native builds on server-pc are a pain.
- Migrations in `src/core/db.ts` are append-only.
- CORS stays an allowlist: `https://vekbui96.github.io`, plus localhost outside production.
- **Contract changes go in both repos.** Edit `docs/api-contract.md` here and in
  `D:\projects\commons\docs\api-contract.md` together, and update the front
  end's `src/api/client.ts` to match.
- No auth yet: no write endpoints or `private` app data exposed until it exists.
- No secrets in the repo; config comes from environment variables.

## Commands

- `npm run verify` before every commit (format check, typecheck, lint, tests; CI runs the same).
- `npm run format` after scripted or bulk edits.

## Deploy

- **Not deployed, and not to be deployed without Ve asking.** No NSSM service,
  no Funnel, nothing under `D:\services`. The plan is in `README.md`.
- Every GitHub comment an agent posts as vekbui96 starts with `<!-- claude-agent -->`
  on its own line.
