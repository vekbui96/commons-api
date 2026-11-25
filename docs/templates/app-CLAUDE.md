# <id> (Commons API app)

Backend for the `<id>` app (front end: `src/apps/<id>/` in `vekbui96/commons`). Mounted at `/api/apps/<id>/`.

- **Routes:** `GET /<path>`: what it returns. (One line per route; no write routes until auth exists.)
- **Data:** KV keys `<key>` (what they hold). Tables, if any: `<id>_<name>` only.
- **Migrations:** none (KV only). Tables need per-app migrations, which core adds with the first app that wants one; they stay this app's own and append-only.
- **Rules:** app-specific rules and gotchas. Shared rules live in the root `CLAUDE.md`.
- **Imports:** this folder and `../../core` only. Never another app.
- **Test:** `npm run check:app -- <id>` while working (tests in this folder); `npm run verify` before commit.

Keep this file to 15 lines or fewer.
