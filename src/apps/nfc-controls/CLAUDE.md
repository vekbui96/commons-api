# nfc-controls (Commons API app)

Editor backend for NFC tags (UI: the `<nfc-controls>` MFE, `vekbui96/nfc-controls`). Mounted at `/api/apps/nfc-controls/`. Contract: `docs/nfc-controls-contract.md` (identical in commons, commons-public, nfc-controls).

- **Routes:** tag CRUD `GET/POST /tags`, `GET/PUT/DELETE /tags/:id`, `POST /tags/:id/reset`, `POST /tags/:id/public/rotate`; history `GET /tags/:id/runs`, `GET /runs`; `GET /status`; `POST /backup/publish`. v1: every tag is public; there is no private run route (runs happen on the gateway).
- **Data:** tables `nfc_controls_tags` (holds the key itself), `nfc_controls_runs`, `nfc_controls_audit` (field names only). Retention: newest 200 runs per tag or 180 days, whichever is more. KV `schemaVersion`, `import` (cursor), `backup`.
- **Migrations:** this app's own append-only `APP_MIGRATIONS` in `store.ts`, applied when the router is created; never edit a shipped one.
- **Hand-off (`publicFiles.ts`):** writes `COMMONS_NFC_SNAPSHOT_PATH` (public projection + key hash only) after every change; reads `COMMONS_NFC_PUBLIC_DB` read-only as **untrusted input**. Never call the gateway, never share `commons.db` with it.
- **Backup:** encrypted `tags.json` to `COMMONS_NFC_BACKUP_REPO` (default `vekbui96/commons-nfc-tags`) via core `putFile`, token `COMMONS_NFC_BACKUP_TOKEN`; debounced after changes. Never log, store or return the token or a key.
- **Imports:** this folder and `../../core` only. Never another app.
- **Test:** `npm run check:app -- nfc-controls` (tests in this folder; owner-only in `test/nfc-controls.test.ts`); `npm run verify` before commit.

Keep this file to 15 lines or fewer.
