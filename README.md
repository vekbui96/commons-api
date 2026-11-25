# Commons API

The backend for [Commons](https://github.com/vekbui96/commons), Ve's home for
small apps and utilities. Express + TypeScript, run with `tsx`, storage in the
built-in `node:sqlite` (Node 24+).

**Not deployed yet: no service, no Funnel.** The front end runs without it.

The contract with the front end (base URL, CORS, health shape, `/api/apps/<id>/`)
is in [`docs/api-contract.md`](docs/api-contract.md), kept identical in both repos.

## One entry point, apps plug in

```
commons-api/
├─ src/
│  ├─ index.ts          the only entry point: one process, one port
│  ├─ server.ts         core routes, CORS, mounts every app router
│  ├─ config.ts         env-driven config
│  ├─ core/
│  │  ├─ db.ts          node:sqlite + append-only migrations
│  │  ├─ kv.ts          key-value store scoped to one app
│  │  └─ apps.ts        discovers src/apps/<id>/routes.ts
│  └─ apps/<id>/routes.ts   an app's backend (none yet)
├─ test/                server tests + a fixture app
└─ docs/api-contract.md
```

- Apps never open their own port, database or process.
- `src/apps/<id>/routes.ts` default-exports `defineAppRouter((ctx) => router)`.
  The entry point finds it on start and mounts it under `/api/apps/<id>/`.
- `ctx` has `id`, `kv` (key-value store scoped to the app) and `db` (the shared
  database; prefix any tables an app adds with its id). Auth will join `ctx`.
- Core routes: `GET /api/health`.

### Adding an app's backend

```ts
// src/apps/<id>/routes.ts  →  served at /api/apps/<id>/count
import { Router } from "express";
import { defineAppRouter } from "../../core/apps";

export default defineAppRouter(({ kv }) => {
  const router = Router();
  router.get("/count", (_req, res) => res.json({ count: kv.get<number>("count") ?? 0 }));
  return router;
});
```

Use the same id as the front-end app folder.

## Local development

```powershell
npm install
npm run dev       # http://127.0.0.1:8790, restarts on change
npm run verify    # format check, typecheck, lint, tests (what CI runs)
```

## Config (environment variables)

| Variable          | Default           | Notes                                           |
| ----------------- | ----------------- | ----------------------------------------------- |
| `COMMONS_PORT`    | `8790`            | 8787/8788/8080/8200 are taken on server-pc      |
| `COMMONS_HOST`    | `127.0.0.1`       | loopback; Funnel proxies to it                  |
| `COMMONS_DB_PATH` | `data/commons.db` | `data/` is gitignored                           |
| `NODE_ENV`        | unset             | `production` drops the localhost CORS allowance |

## Database

`src/core/db.ts` holds an append-only `MIGRATIONS` list; `PRAGMA user_version`
records how many have run, and they apply on start. Migration 1 creates
`app_kv (app_id, key, value JSON, updated_at)`. Never edit a shipped migration;
add a new one.

## Deploying later (plan, not done)

1. Live checkout at `D:\services\commons-api` (fetch/reset only, like cardlens),
   then `npm.cmd install --no-audit --no-fund`. Never `--omit=dev`: `tsx` is a
   dev dependency.
2. NSSM service `commons-api` running `node_modules\.bin\tsx.cmd src\index.ts`
   in `D:\services\commons-api`, with `NODE_ENV=production` and
   `COMMONS_DB_PATH=D:\services\data\commons\commons.db`, logs in `D:\services\logs\`.
3. Tailscale Funnel only exposes ports 443, 8443 and 10000. 8443 is CardLens's;
   use 443 or 10000 (e.g. `tailscale funnel --bg --https=10000 http://127.0.0.1:8790`).
4. Set the repo variable for the front end's `VITE_COMMONS_API` to the public URL.
5. Add the database file to the nightly backup and the ops hub health checks.
6. Auth must exist before any `private` app or write endpoint is exposed.
