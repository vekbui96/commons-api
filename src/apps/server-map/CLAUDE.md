# server-map (Commons API app)

Backend for the `server-map` app (front end: `src/apps/server-map/` in `vekbui96/commons`). Mounted at `/api/apps/server-map/`.

- **Routes:** `GET /architecture`: the hub's architecture map JSON, as is (`Cache-Control: no-store`). `503 map_not_ready` when the file is missing; `502 map_invalid` for bad JSON, `schema !== 1`, `nodes`/`edges` not arrays, or over 1 MB. Contract: `docs/api-contract.md`, "server-map".
- **Data:** none in the database. Reads one file, read-only: env `COMMONS_ARCH_PATH`, default `D:\hub\state\architecture.json` (written by the ops hub, `D:\hub`). Cached by mtime + size.
- **Migrations:** none.
- **Rules:** never write the file. Validate only the top level (schema v1); the hub owns the rest of the shape. Error bodies carry a code only, never a path or file system message. The deploy script sets `COMMONS_ARCH_PATH` in the NSSM environment.
- **Imports:** this folder and `../../core` only. Never another app.
- **Test:** `npm run check:app -- server-map` while working (tests in this folder; owner-only check in `test/server-map.test.ts`); `npm run verify` before commit.

Keep this file to 15 lines or fewer.
