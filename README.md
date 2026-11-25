# Commons server

Express + TypeScript, run with `tsx`, storage in the built-in `node:sqlite`
(Node 24+). **Scaffolded only: not installed as a service, not on Funnel.**

## One entry point, apps plug in

- `src/index.ts` is the only entry point: one process, one port.
- `src/server.ts` registers core routes, then mounts each discovered app router
  under `/api/apps/<id>/`.
- `src/apps/<id>/routes.ts` default-exports `defineAppRouter((ctx) => router)`.
  `ctx` has `id`, `kv` (key-value store scoped to the app) and `db` (the shared
  database; prefix any tables an app adds with its id). Auth will join `ctx`.
- Apps never open their own port, database or process.

## Config (environment variables)

| Variable          | Default                  | Notes                                           |
| ----------------- | ------------------------ | ----------------------------------------------- |
| `COMMONS_PORT`    | `8790`                   | 8787/8788/8080/8200 are taken on server-pc      |
| `COMMONS_HOST`    | `127.0.0.1`              | loopback; Funnel proxies to it                  |
| `COMMONS_DB_PATH` | `server/data/commons.db` | `data/` is gitignored                           |
| `NODE_ENV`        | unset                    | `production` drops the localhost CORS allowance |

CORS allows only `https://vekbui96.github.io`, plus `http://localhost:*` and
`http://127.0.0.1:*` outside production.

## Database

`src/core/db.ts` holds an append-only `MIGRATIONS` list; `PRAGMA user_version`
records how many have run, and they apply on start. Migration 1 creates
`app_kv (app_id, key, value JSON, updated_at)`. Never edit a shipped migration;
add a new one.

## Deploying later (plan, not done)

1. Live checkout at `D:\services\commons` (fetch/reset only, like cardlens), then
   `npm.cmd install --no-audit --no-fund`. Never `--omit=dev`: `tsx` is a dev dependency.
2. NSSM service `commons` running `node_modules\.bin\tsx.cmd src\index.ts` in
   `D:\services\commons\server`, with `NODE_ENV=production` and
   `COMMONS_DB_PATH=D:\services\data\commons\commons.db`, logs in `D:\services\logs\`.
3. Tailscale Funnel only exposes ports 443, 8443 and 10000. 8443 is CardLens's;
   use 443 or 10000 (e.g. `tailscale funnel --bg --https=10000 http://127.0.0.1:8790`).
4. Add the database file to the nightly backup and the ops hub health checks.
5. Auth must exist before any `private` app or write endpoint is exposed.
