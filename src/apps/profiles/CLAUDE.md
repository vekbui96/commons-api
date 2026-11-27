# profiles (Commons API app)

Backend for visitor profiles (front end: `src/profiles/` in `vekbui96/commons`, read by the public build from the Pages file). Mounted at `/api/apps/profiles/`.

- **Routes:** `GET /profiles` (draft + `dirty`), `PUT /profiles/:id` (create 201 / replace 200), `DELETE /profiles/:id`, `PUT /guest`, `GET /export` (exact file), `GET /publish` (status), `POST /publish` (write the file to GitHub). Contract: `docs/api-contract.md`, "profiles".
- **Data:** KV `draft` (`revision`, `updatedAt`, `guest`, `profiles`) and `published` (last publish: revision, time, commit SHA, content baseline for `dirty`, last attempt/error). Seeded once with the iteration-1 content as the baseline. No tables.
- **Publish:** GitHub contents API (`putFile` from core, `src/core/github.ts`) to `COMMONS_PROFILES_REPO` (default `vekbui96/commons-profiles`), `profiles.json` on `main`, token `COMMONS_PROFILES_TOKEN` (read via `ctx.env`). No token: `503 publish_not_configured`.
- **Rules:** validation matches the front end's `parseProfiles` (`model.ts`); the file must stay what it accepts (iteration-1 shape + `revision`). Never log, store or return the token; errors carry a code and HTTP status only.
- **Imports:** this folder and `../../core` only. Never another app.
- **Test:** `npm run check:app -- profiles` (fake GitHub in `routes.test.ts`; owner-only check in `test/profiles.test.ts`); `npm run verify` before commit.

Keep this file to 15 lines or fewer.
