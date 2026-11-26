# Commons API

The backend for [Commons](https://github.com/vekbui96/commons), Ve's home for
small apps and utilities. Express + TypeScript (`tsx` in development, compiled
to plain JS for production), storage in the built-in `node:sqlite` (Node 24+).

**Deployed on server-pc, tailnet only:** NSSM service `commons-api` on
`127.0.0.1:8790`, reached at **https://server-pc.tail0e4194.ts.net:8445/api/**
through `tailscale serve`. **Never on Funnel.** See [Deploy](#deploy).

The contract with the front end (where it runs, origins, identity, CSRF, health
shape, `/api/apps/<id>/`) is in [`docs/api-contract.md`](docs/api-contract.md),
kept identical in both repos.

## One entry point, apps plug in

```
commons-api/
├─ src/
│  ├─ index.ts          the only entry point: one process, one port
│  ├─ server.ts         core routes, security guards, mounts every app router
│  ├─ config.ts         env-driven config
│  ├─ core/
│  │  ├─ db.ts          node:sqlite + append-only migrations
│  │  ├─ kv.ts          key-value store scoped to one app
│  │  ├─ apps.ts        discovers src/apps/<id>/routes.ts
│  │  ├─ security.ts    origin allowlist, owner identity, CSRF on writes
│  │  ├─ tailscale.ts   owner login + tailnet IPs from tailscale, tailscaled peer check
│  │  └─ index.ts       the public interface apps import
│  └─ apps/<id>/        an app's backend: routes.ts, CLAUDE.md, tests (server-map, profiles)
├─ eslint/              local lint rule: the wall between apps
├─ scripts/             check-app.ps1 (one app), build.mjs (dist/), deploy.ps1
├─ test/                server tests, lint-rule tests, a fixture app
└─ docs/                api-contract.md, templates/app-CLAUDE.md
```

- Apps never open their own port, database or process.
- `src/apps/<id>/routes.ts` default-exports `defineAppRouter((ctx) => router)`.
  The entry point finds it on start and mounts it under `/api/apps/<id>/`.
- `ctx.env(name)` reads a `COMMONS_*` environment variable (trimmed, empty is
  `undefined`; any other name throws), so apps never import `src/config.ts`.
- `ctx` has `id`, `kv` (key-value store scoped to the app) and `db` (the shared
  database; prefix any tables an app adds with its id).
- Core routes: `GET /api/health` (open) and `GET /api/session` (owner only:
  login + CSRF token).
- **Everything under `/api/apps/` is owner only** (Tailscale identity from
  `tailscale serve`), and its writes need an allowed `Origin` plus the CSRF
  token in `X-Commons-Token`. Core enforces this before any app router runs, so
  an app's routes never check auth themselves.

### Adding an app's backend

```ts
// src/apps/<id>/routes.ts  →  served at /api/apps/<id>/count
import { Router } from "express";
import { defineAppRouter } from "../../core";

export default defineAppRouter(({ kv }) => {
  const router = Router();
  router.get("/count", (_req, res) => res.json({ count: kv.get<number>("count") ?? 0 }));
  return router;
});
```

Use the same id as the front-end app folder. Every app folder also gets:

- **A short `CLAUDE.md`** from [`docs/templates/app-CLAUDE.md`](docs/templates/app-CLAUDE.md)
  (routes, data, rules, how to test; 15 lines or fewer). App detail lives
  there, never in the root `CLAUDE.md`. A test fails if it is missing.
- **Its tests** next to its code (`src/apps/<id>/*.test.ts`).

### The wall between apps

- An app imports only its own folder and `src/core` through its public
  interface, `src/core/index.ts` (`defineAppRouter`, `AppContext`, `AppKv`).
- Nothing outside an app, core included, imports the app's code; core mounts
  apps through auto-discovery only.
- The ESLint rule `commons/app-boundaries` ([`eslint/app-boundaries.js`](eslint/app-boundaries.js))
  fails the lint on any import that crosses the wall.
- Each app owns its own tables, prefixed with its id, and its own migrations,
  and never reads another app's tables.
- No source imports between apps: a finished app is reused only through its
  published API or embed, never by copying or importing its code.

## Local development

```powershell
npm install
npm run dev       # http://127.0.0.1:8790, restarts on change
npm run check:app -- <id>   # one app: typecheck, lint, its tests (+ core tests if core changed)
npm run verify    # format check, typecheck, lint, tests (what CI runs)
```

Run the scoped `check:app` while working on an app and the full `verify` once
before committing. CI always runs the full `verify`. `check:app` is a
PowerShell script (`scripts/check-app.ps1`), for this Windows box.

## Config (environment variables)

| Variable                 | Default                          | Notes                                                                                                                                                                                               |
| ------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMONS_PORT`           | `8790`                           | 8787/8788/8080/8200 are taken on server-pc                                                                                                                                                          |
| `COMMONS_HOST`           | `127.0.0.1`                      | loopback only; the identity headers are trusted only because of this                                                                                                                                |
| `COMMONS_DB_PATH`        | `data/commons.db`                | `data/` is gitignored; `identity.json` is cached next to it                                                                                                                                         |
| `NODE_ENV`               | unset                            | `production`: no localhost origins, Host must be the 8445 name, owner read from tailscale, TCP peer must be tailscaled                                                                              |
| `COMMONS_OWNER_LOGIN`    | from `tailscale status`          | override the owner's tailnet login (never commit it)                                                                                                                                                |
| `COMMONS_PUBLIC_HOST`    | the 8445 host in production      | the `Host` that identity routes require                                                                                                                                                             |
| `COMMONS_ARCH_PATH`      | `D:\hub\state\architecture.json` | `server-map`: the hub's architecture map, read-only                                                                                                                                                 |
| `COMMONS_PROFILES_REPO`  | `vekbui96/commons-profiles`      | `profiles`: the repo `POST /publish` writes `profiles.json` to (branch `main`)                                                                                                                      |
| `COMMONS_PROFILES_TOKEN` | unset                            | `profiles`: **secret**, fine-grained GitHub token (Contents read/write on that repo only). Unset: publish answers `503`. Set with `npm run deploy -- -SetProfilesToken` (elevated); deploys keep it |

## Database

`src/core/db.ts` holds an append-only `MIGRATIONS` list; `PRAGMA user_version`
records how many have run, and they apply on start. Migration 1 creates
`app_kv (app_id, key, value JSON, updated_at)`. Never edit a shipped migration;
add a new one.

## Deploy

Deployed 2026-11-25 at Ve's request. **Tailnet only, never Funnel.**

|                 |                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service         | NSSM `commons-api`, automatic start (runs at boot without a logon), LocalSystem                                                                                                     |
| Runs            | `node.exe --enable-source-maps --max-semi-space-size=1 --max-old-space-size=96 --v8-pool-size=1 D:\services\commons-api\dist\index.js`                                              |
| Env             | `NODE_ENV=production`, `COMMONS_PORT=8790`, `COMMONS_HOST=127.0.0.1`, `COMMONS_DB_PATH=D:\services\commons-api\data\commons.db`, `COMMONS_ARCH_PATH=D:\hub\state\architecture.json` |
| Listens         | `127.0.0.1:8790` only                                                                                                                                                               |
| Public face     | `https://server-pc.tail0e4194.ts.net:8445/` via `tailscale serve`, tailnet only: `/` = `D:\services\commons-web` (private front-end build), `/api` = `http://127.0.0.1:8790/api`    |
| Data            | `D:\services\commons-api\data\commons.db` (+ `identity.json`, the owner-login cache). Never in the repo                                                                             |
| Logs            | `D:\services\logs\commons-api.out.log` and `commons-api.err.log` (rotated at 10 MB)                                                                                                 |
| Deployed commit | `D:\services\commons-api\DEPLOYED.txt`                                                                                                                                              |

The `/api` proxy target keeps the `/api` path on purpose: with a bare
`http://127.0.0.1:8790` target, `--set-path=/api` strips the mount and the
server would see `/health` (checked 2026-11-25).

**Deploy** (elevated PowerShell, from a clean, pushed `main`):

```powershell
cd D:\projects\commons-api
npm run deploy            # verify, build dist/, stop, swap dist (old one -> dist.prev), npm ci --omit=dev if the lockfile changed, start, health check
npm run deploy -- -Serve  # also (re)apply the two 8445 serve handlers (prints serve status before and after)
```

`npm run build` alone writes `dist/` (esbuild: `dist/index.js`,
`dist/apps/<id>/routes.js`, shared `dist/chunks/`); `npm run start:prod` runs
it. If health does not come up after a deploy, the script rolls back by itself.

**Roll back** to the previous deploy: `npm run deploy -- -Rollback` (elevated).
It puts `dist.prev` back (with its `package*.json`, reinstalling dependencies if
they differ), restarts and health-checks; the failed build stays in `dist.bad`.
Deploy and rollback never touch the database; migrations are append-only, so an
older build still opens it.

**Secrets:** `npm run deploy -- -SetProfilesToken` (elevated) prompts for
`COMMONS_PROFILES_TOKEN`, stores it in the service's `AppEnvironmentExtra`
(keeping the other variables) and restarts. Every deploy keeps extra variables
it does not manage and prints variable names only, never values.

**Check it:**

```powershell
Get-Service commons-api
curl.exe -s http://127.0.0.1:8790/api/health
& 'C:\Program Files\Tailscale\tailscale.exe' serve status   # 8445 must say (tailnet only)
```

On server-pc the tailnet name resolves to the public Funnel relays, so pin it to
the tailnet IP:
`curl.exe --resolve server-pc.tail0e4194.ts.net:8445:100.75.251.52 https://server-pc.tail0e4194.ts.net:8445/api/health`.
Owner-only routes refuse requests from server-pc itself (`self_request`); test
them from a phone or laptop on the tailnet.

**Turn it off** (only this API's handlers; the Funnel sites and the hub stay up):

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --https=8445 off
Stop-Service commons-api   # elevated; Set-Service commons-api -StartupType Disabled keeps it off
```

**Never** run `tailscale serve reset` or `tailscale funnel reset` (Serve and
Funnel share one config; a reset takes the public sites down), never put 8445
on Funnel, and never touch another port (443, 8443, 8444, 8446 and 8460-8464
belong to other services).

Still to do: add `data\commons.db` to the nightly off-machine backup.
