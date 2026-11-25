# CLAUDE.md

Commons API: the backend for Commons. The front end is a separate repo,
`vekbui96/commons` (`D:\projects\commons`). Architecture and the add-an-app
steps are in `README.md`; the shared contract is `docs/api-contract.md`.

This file is a short index plus the shared rules. **App detail never goes
here**: each app under `src/apps/<id>/` with backend code has its own short
`CLAUDE.md` in its folder (template: `docs/templates/app-CLAUDE.md`, 15 lines
or fewer). A test fails if an app folder lacks one. Read the app's file when
working on that app.

## Rules

- **One entry point, apps plug in.** `src/index.ts` is the only process and
  port. An app's backend is `src/apps/<id>/routes.ts` exporting a router
  factory, auto-mounted under `/api/apps/<id>/`. Shared things (health, db,
  per-app KV, later auth) stay in `src/core/`. Never start a second server or
  port for an app.
- Storage is the built-in `node:sqlite`. **No better-sqlite3** or other native
  modules: native builds on server-pc are a pain.
- Migrations in `src/core/db.ts` are append-only.
- **Security lives in `src/core/security.ts`** (contract: "Security"). Origins
  are an allowlist (`https://server-pc.tail0e4194.ts.net:8445`,
  `https://vekbui96.github.io`, localhost outside production); a present,
  disallowed `Origin` is refused. `/api/health` is open; `/api/session` and
  everything under `/api/apps/` need the owner's Tailscale identity; writes
  also need an allowed Origin and the CSRF token. Apps never do their own auth
  and never weaken these checks.
- The server listens on 127.0.0.1 only; that is why the identity headers can be
  trusted. Never bind it elsewhere. The owner login is config (env or
  `tailscale status`), never in the repo.
- **Contract changes go in both repos.** Edit `docs/api-contract.md` here and in
  `D:\projects\commons\docs\api-contract.md` together, and update the front
  end's `src/api/client.ts` to match.
- No secrets or emails in the repo; config comes from environment variables.

## The wall between apps

- An app imports only from its own folder and from `src/core/index.ts` (the
  core's public interface, `../../core`). Never from another app, never from
  other core modules, `src/server.ts`, `src/config.ts` or `test/`.
- Core (and anything else outside the app) never imports an app's internals;
  apps are mounted only by the auto-discovery in `src/core/apps.ts`.
- ESLint enforces both: `commons/app-boundaries` (`eslint/app-boundaries.js`,
  tested in `test/app-boundaries.test.ts`). Don't disable it; fix the import.
- **Data:** each app owns its own tables, prefixed with its id (`<id>_...`), and
  its own migrations. Apps never read or write another app's tables or KV.
- **Reuse:** no source imports between apps. A finished app is reused only
  through its published API or embed, never by copying or importing its code.
  Code two apps need goes into `src/core` as a deliberate shared feature.

## Commands

- While working on one app: `npm run check:app -- <id>` (typecheck, lint and
  tests for `src/apps/<id>/`, plus core lint and tests when core has changes).
- `npm run verify` once before every commit (format check, typecheck, lint, all
  tests; CI runs the same, always in full).
- `npm run format` after scripted or bulk edits.

## Deploy

- **Deployed, tailnet only, never Funnel.** NSSM service `commons-api` runs
  `node dist\index.js` from `D:\services\commons-api` on `127.0.0.1:8790`;
  `tailscale serve` puts it at `https://server-pc.tail0e4194.ts.net:8445/api/`
  (the private front end is `/` there, from `D:\services\commons-web`). Data:
  `D:\services\commons-api\data\commons.db`. Details: `README.md`, "Deploy".
- Deploy only when Ve asks; pushing `main` deploys nothing. Deploy with
  `npm run deploy` from an elevated shell (verify, build, swap, restart, health
  check, auto-rollback). Roll back with `npm run deploy -- -Rollback`.
- Never `tailscale serve reset` / `funnel reset`, never put 8445 on Funnel, never
  touch another port's handlers or other services on the box.
- Every GitHub comment an agent posts as vekbui96 starts with `<!-- claude-agent -->`
  on its own line.
