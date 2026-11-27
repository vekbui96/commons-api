# NFC controls contract (v1)

Identical in `vekbui96/commons-api`, `vekbui96/commons-public`, `vekbui96/commons` and
`vekbui96/nfc-controls`. Change it in all of them together. Status: **final for v1**
(2026-11-27). Plan and Ve's decisions: `D:\projects\plans\2026-11-27-nfc-controls\`.

## Scope of v1

- **Every tag is public.** A tag works for anyone who taps it, with no Tailscale. There
  are no private tags in v1.
- **Editing is private:** the "NFC controls" tab in private Commons, through the private
  commons-api app `/api/apps/nfc-controls/` (tailnet only, owner only).
- **Running is public:** the runner calls the public gateway `commons-public`
  (Funnel :10000). It never calls the private API.
- Three action types: `open_url`, `log`, `note`. No forward, toggle or checklist.
- Nothing runs on page load. The runner always shows one **Run** button. No auto-run.
- Run history: per tag, the newest 200 runs or everything from the last 180 days,
  whichever is more.

## URLs

| What                                     | URL                                                               |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Tag link (written on the tag)            | `https://vekbui96.github.io/commons/#/t/<id>?k=<key>`             |
| Public gateway base (`VITE_NFC_GATEWAY`) | `https://server-pc.tail0e4194.ts.net:10000/public/v1`             |
| Static backup copy                       | `https://vekbui96.github.io/commons-nfc-tags/tags.json`           |
| Private editor API                       | `https://server-pc.tail0e4194.ts.net:8445/api/apps/nfc-controls/` |

- `id`: 12 random characters `[a-z0-9]` made by the server, or a claimed id matching
  `^[a-z0-9]+(-[a-z0-9]+)*$`, 1-32 characters. Fixed once created.
- `key`: 24 characters `[A-Za-z0-9_-]` (base64url of 18 random bytes, 144 bits). Never
  the id. Rotating it changes the link, **so the physical tag must be rewritten**.
- The key is only ever in the page **hash** (`?k=` after `#`, never sent to Pages) and in
  the **`X-Tag-Key` request header**. Never in a query string, path or body.
- The server builds `publicLink` from `COMMONS_NFC_PUBLIC_LINK_BASE` (default
  `https://vekbui96.github.io/commons/#/t/`) + `id` + `?k=` + `key`.

## Action types

`Action = { "type": <type>, "params": { ... } }`. Unknown params keys are dropped.

| Type       | Params (editor)                                                     | Public projection        | A public run                                                                                                                           |
| ---------- | ------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `open_url` | `url` (required), `label` (1-60)                                    | `{ url, label }`         | the runner navigates to `url` inside the tap; it sends the run request with `keepalive: true` and does not wait for it. Code `opened`  |
| `log`      | `label` (1-60)                                                      | `{ label }`              | records a tap. Code `counted`, or `deduped` / `capped` (not counted). **The tapper never sees a count**: the answer is always "Logged" |
| `note`     | `title` (0-80), `text` (0-4000), `items` (0-50 strings, each 1-200) | `{ title, text, items }` | records a view. Code `shown`                                                                                                           |

- `note` needs a non-empty `text` or at least one item. `title` defaults to `""`,
  `items` to `[]`.
- `open_url.url`, at most 2000 characters, must be one of:
  - `https://` with a host, no user name or password;
  - `shortcuts://run-shortcut?name=<name>`, optionally with `&input=text&text=<text>`.
    No other `shortcuts:` path or parameter (no `input=clipboard`). It runs the tapper's
    own Shortcut of that name, and iOS asks them first.
- No `http:`, `javascript:`, `data:` or any other scheme. The gateway re-checks this on
  every tag it serves.

## Private editor API (commons-api app `nfc-controls`)

Under `/api/apps/nfc-controls/`. Core rules apply first (contract `api-contract.md`,
"Security"): owner identity on every route, an allowed `Origin` and `X-Commons-Token` on
every write. Every answer has `Cache-Control: no-store`. Errors are
`{ "ok": false, "error": "<code>", ... }`. Times are ISO 8601 UTC.

### Shapes

**Tag**

```json
{
  "id": "k7m2q9xpa3b4",
  "name": "Fridge note",
  "enabled": true,
  "notes": "",
  "action": { "type": "note", "params": { "title": "Hi", "text": "Milk", "items": [] } },
  "public": true,
  "publicLink": "https://vekbui96.github.io/commons/#/t/k7m2q9xpa3b4?k=AAAAAAAAAAAAAAAAAAAAAAAA",
  "inBackup": true,
  "revision": 3,
  "createdAt": "2026-11-27T18:00:00.000Z",
  "updatedAt": "2026-11-27T18:10:00.000Z",
  "count": 0,
  "runCount": 12,
  "lastRun": {
    "id": 81,
    "tagId": "k7m2q9xpa3b4",
    "at": "2026-11-27T18:12:00.000Z",
    "via": "public",
    "actionType": "note",
    "ok": true,
    "code": "shown",
    "message": "Note shown"
  }
}
```

- `name`: 1-60 characters after trimming, no control characters.
- `notes`: private notes, 0-2000 characters. Never public, never in the snapshot or backup.
- `enabled: false` takes the tag off the gateway and out of the backup (it answers
  `tag_unavailable`) without changing its link.
- `public` is always `true` in v1.
- `inBackup`: the tag is in the static backup copy (`enabled` and `open_url` or `note`).
- `count`: taps counted by a `log` tag (`counted` runs) since it was made or last reset.
  `0` for other types. `runCount`: all public runs recorded for the tag.
- `revision` starts at 1 and goes up on every change (edit, reset, key rotation).
- **List rows** (`GET /tags`) are the same object without `notes`.

**Run** (read only; v1 runs come only from the public gateway)

```json
{
  "id": 81,
  "tagId": "k7m2q9xpa3b4",
  "at": "2026-11-27T18:12:00.000Z",
  "via": "public",
  "actionType": "log",
  "ok": true,
  "code": "counted",
  "message": "Counted"
}
```

| `code`    | `message`                               | Counted |
| --------- | --------------------------------------- | ------- |
| `opened`  | `Link opened`                           |         |
| `shown`   | `Note shown`                            |         |
| `counted` | `Counted`                               | yes     |
| `deduped` | `Not counted: same visitor within 60 s` | no      |
| `capped`  | `Not counted: daily cap reached`        | no      |

`message` is written by commons-api from `code`; the gateway's data is never shown as is.

### Endpoints

| Method + path                                | Body                                                           | Success                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /tags`                                  |                                                                | `200 { ok, tags: TagRow[] }`, sorted by name                                                    |
| `GET /tags/:id`                              |                                                                | `200 { ok, tag }`                                                                               |
| `POST /tags`                                 | `{ id?, name, action, enabled?, notes? }`                      | `201 { ok, tag }`; the server makes `id` (if omitted) and `key`                                 |
| `PUT /tags/:id`                              | `{ name, action, enabled?, notes?, revision? }` (full replace) | `200 { ok, tag }`                                                                               |
| `DELETE /tags/:id`                           |                                                                | `200 { ok: true }`; its runs go too, the link dies                                              |
| `POST /tags/:id/reset`                       |                                                                | `200 { ok, tag }`; `count` back to 0                                                            |
| `POST /tags/:id/public/rotate`               |                                                                | `200 { ok, tag }`; new key and `publicLink`, the old link stops working                         |
| `GET /tags/:id/runs?limit=20&before=<runId>` |                                                                | `200 { ok, runs: Run[], nextBefore: number \| null }`, newest first, `limit` 1-200 (default 20) |
| `GET /runs?limit=50&before=<runId>`          |                                                                | the same, across all tags (default 50)                                                          |
| `GET /status`                                |                                                                | `200 { ok, gateway, backup }` (below)                                                           |
| `POST /backup/publish`                       |                                                                | `200 { ok, backup }`; publishes the backup copy now                                             |

- Defaults: `enabled: true`, `notes: ""`. Unknown body keys are ignored. An `id` in a
  `PUT` body must equal the URL's.
- `PUT` with `revision` replaces only if it matches, else `409 revision_mismatch` with
  the current `revision`. Changing `action.type` resets `count` to 0.
- Reads of tags, runs and status first pick up new public runs (at most every 5 s; also
  every 10 minutes in the background).
- Every change rewrites the gateway snapshot at once, and (when a token is set)
  republishes the backup copy a few seconds later.

`GET /status`:

```json
{
  "ok": true,
  "gateway": {
    "snapshot": { "configured": true, "writtenAt": "2026-11-27T18:10:00.000Z", "tags": 3, "error": null },
    "runs": { "configured": true, "importedAt": "2026-11-27T18:12:05.000Z", "error": null }
  },
  "backup": {
    "configured": true,
    "repo": "vekbui96/commons-nfc-tags",
    "url": "https://vekbui96.github.io/commons-nfc-tags/tags.json",
    "dirty": false,
    "tags": 2,
    "publishedAt": "2026-11-27T18:10:03.000Z",
    "commitSha": "abc123",
    "lastAttemptAt": "2026-11-27T18:10:03.000Z",
    "lastError": null
  }
}
```

`lastError` is `{ error, status?, at }` with a code only. `configured: false` means the
setting is unset on this server (local development, or no backup token yet).

### Errors

| Status | `error`                 | When                                                                              |
| ------ | ----------------------- | --------------------------------------------------------------------------------- |
| `400`  | `invalid_tag`           | the body or `:id` breaks a rule; `problems: string[]` (for display, not matching) |
| `400`  | `unknown_action_type`   | `action.type` is not `open_url`, `log` or `note`                                  |
| `400`  | `invalid_query`         | bad `limit` or `before`                                                           |
| `404`  | `tag_not_found`         | unknown id                                                                        |
| `409`  | `tag_exists`            | `POST /tags` with an `id` that is taken                                           |
| `409`  | `revision_mismatch`     | stale `revision`; includes `revision`                                             |
| `409`  | `backup_in_progress`    | a publish is already running                                                      |
| `502`  | `backup_failed`         | GitHub refused or did not answer; `reason` (a code), `status?`                    |
| `503`  | `backup_not_configured` | `COMMONS_NFC_BACKUP_TOKEN` is not set                                             |

## Public gateway (`commons-public`)

Base `https://server-pc.tail0e4194.ts.net:10000/public/v1` (Funnel :10000 →
`127.0.0.1:8792`). Only these routes exist; anything else is
`404 { "ok": false, "error": "not_found" }`.

| Request                                                                                                              | Success                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /health` (also `/health` at the root)                                                                           | `200 { ok: true, service: "commons-public", snapshot: "ok" \| "missing" \| "invalid" }` |
| `GET /nfc/t/:id` + header `X-Tag-Key`                                                                                | `200 { ok: true, tag: { id, name, action: PublicAction } }`                             |
| `POST /nfc/t/:id/run` + headers `X-Tag-Key`, `Content-Type: application/json`, optional `Idempotency-Key`; body `{}` | `200 { ok: true, run: { at, ok: true, message }, replayed?: true }`                     |

- `PublicAction` is `{ type, params }` with the public projection above, nothing else:
  no notes, counts, history, key, key hash or revision.
- Run `message`: `open_url` → `"Opened"`, `note` → `"Shown"`, `log` → `"Logged"`
  (whether or not it counted).
- `Idempotency-Key`: 8-64 characters `[A-Za-z0-9_-]`, a fresh one per tap (a UUID is
  fine). The same key for the same tag within 10 minutes returns the first answer with
  `replayed: true` and records nothing.
- **Every failure on a tag route is the same answer**,
  `404 { "ok": false, "error": "tag_unavailable" }`: unknown id, missing or wrong key,
  disabled tag, malformed id, key or `Idempotency-Key`, a body that is not JSON or over
  1 KB, a missing JSON content type. The runner shows "This tag isn't available."
- `429 { "ok": false, "error": "rate_limited", "retryAfter": <seconds> }` and
  `503 { "ok": false, "error": "busy", "retryAfter": <seconds> }`.
- **CORS:** only `Origin: https://vekbui96.github.io` gets
  `Access-Control-Allow-Origin` (no wildcard, no credentials). A request with any other
  `Origin` gets `403 { "ok": false, "error": "origin_not_allowed" }`. Preflight allows
  methods `GET, POST` and headers `Content-Type, X-Tag-Key, Idempotency-Key`, max age
  600 s. Requests without `Origin` (curl) are served without CORS headers.
- Every answer has `Cache-Control: no-store`.

### Limits

| Limit                             | Value                 | When over                            |
| --------------------------------- | --------------------- | ------------------------------------ |
| per IP, all routes                | 30 / minute           | `429`                                |
| per IP, `tag_unavailable` answers | 10 / minute           | `429` for 10 minutes (lockout)       |
| per tag, runs                     | 30 / hour             | `429`                                |
| per tag + IP, `log` counts        | 1 per 60 s            | run answers "Logged", code `deduped` |
| per tag, `log` counts per UTC day | 500                   | run answers "Logged", code `capped`  |
| whole gateway                     | 300 requests / minute | `503 busy`                           |

The client IP is the last `X-Forwarded-For` entry, trusted only when the TCP peer is
loopback (tailscaled's Funnel proxy). Otherwise the peer address.

## Hand-off files (commons-api ↔ commons-public)

Two files, one direction each. The two processes share nothing else: no database, no
HTTP, no secret.

1. **Snapshot, private → public:** commons-api writes
   `D:\services\commons-public\snapshot\public-tags.json` (`COMMONS_NFC_SNAPSHOT_PATH`;
   the gateway's `GATEWAY_SNAPSHOT_PATH`), to a temp file and then renamed, on start and
   after every change. The gateway reloads it when its modification time changes, and
   re-validates every entry (an invalid entry is skipped).

   ```json
   {
     "version": 1,
     "generatedAt": "2026-11-27T18:10:00.000Z",
     "tags": [
       {
         "id": "k7m2q9xpa3b4",
         "name": "Fridge note",
         "keyHash": "1bda9f0aed80857d43c9329457f28b1ca29f736a0c539901e1ba16a909eb07b4",
         "action": { "type": "note", "params": { "title": "Hi", "text": "Milk", "items": [] } }
       }
     ]
   }
   ```

   Only enabled tags, only the public projection, and `keyHash` = lowercase hex
   SHA-256 of the key's UTF-8 bytes (the gateway compares in constant time). Never the
   key, notes, counts or revision. The links cannot be rebuilt from this file.

2. **Runs, public → private:** the gateway writes
   `D:\services\commons-public\data\public.db` (`GATEWAY_DB_PATH`; commons-api's
   `COMMONS_NFC_PUBLIC_DB`), SQLite in rollback-journal mode. commons-api opens it
   **read-only** and imports rows as **untrusted input**: validated, capped per pass,
   only for tags it knows, malformed rows skipped. Tables the private side reads:

   ```sql
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'instance': random id, new db = new id
   CREATE TABLE public_runs (
     id INTEGER PRIMARY KEY, at TEXT NOT NULL, tag_id TEXT NOT NULL,
     action_type TEXT NOT NULL, code TEXT NOT NULL                   -- opened | shown | counted | deduped | capped
   );
   ```

   The gateway keeps `public_runs` for 200 days. Its request audit (`public_audit`) is
   its own and is not imported.

## Static backup copy (GitHub Pages)

So `open_url` and `note` tags still work while server-pc is down. commons-api publishes
`tags.json` to the public repo `vekbui96/commons-nfc-tags` (`COMMONS_NFC_BACKUP_REPO`,
branch `main`) through the GitHub contents API with the fine-grained token
`COMMONS_NFC_BACKUP_TOKEN`. Served at
`https://vekbui96.github.io/commons-nfc-tags/tags.json` (Pages answers with
`Access-Control-Allow-Origin: *`).

The file is world-readable, so **every entry is encrypted with a key derived from the
tag's link**: without the link, the file shows neither ids, names, nor contents, only
how many entries there are. `log` tags and disabled tags are never in it.

```json
{ "version": 1, "tags": { "<lookup>": { "iv": "<base64url>", "data": "<base64url>" } } }
```

For a tag with `id` and `key` (UTF-8 throughout, `\n` is one line feed):

- `lookup` = lowercase hex SHA-256 of `"commons-nfc-backup/v1/lookup\n" + id + "\n" + key`
- `aesKey` = the 32 raw bytes of SHA-256 of `"commons-nfc-backup/v1/key\n" + id + "\n" + key`
- `data` = AES-256-GCM of the plaintext with `aesKey` and the 12-byte `iv`, no
  additional data, the 16-byte tag appended (WebCrypto's layout)
- plaintext = JSON `{ "id", "name", "action": PublicAction }`, the same as the
  gateway's `tag`

The runner, only when the gateway is unreachable (network error, timeout, 5xx; never on
`tag_unavailable` or `rate_limited`): fetch the file, compute `lookup`, decrypt, check that
the decrypted `id` equals the link's id, then show the tag with a note that taps are not
being recorded. A run then sends nothing. The server derives the `iv` from the content
(the first 12 bytes of SHA-256 of `aesKey` + plaintext), so an unchanged tag publishes
the same bytes; clients just read `iv`.

Test vector: `id` = `k7m2q9xpa3b4`, `key` = `AAAAAAAAAAAAAAAAAAAAAAAA`

- `keyHash` = `1bda9f0aed80857d43c9329457f28b1ca29f736a0c539901e1ba16a909eb07b4`
- `lookup` = `053499967efe7c1f17b9ac389be2d955da6df3d0dff73b01beb6f342772583ba`
- plaintext = `{"id":"k7m2q9xpa3b4","name":"Fridge note","action":{"type":"note","params":{"title":"Hi","text":"Milk","items":[]}}}`
- `iv` = `grJ_jyV7Mhx5lyMC`
- `data` = `y_ia3OGX_arKiWGrETB8SeiHjrvKvuaqHcxYB8HCDvp1oc7pHf-RcMtbLAI230gWd1m84Q3y5uMh4JWbgwniqWxLivzwKcCcxNg9zTRnJmYCVlqxFzUtme2gqtrVKk2W4GBI0F8c6SU2mRbCo8I610JW213xN6V0BZF0d8q5ok-nViJ0`

## Runner flow (for the front end)

1. Load `#/t/<id>?k=<key>`. A missing or malformed `k` → "This tag isn't available."
   (no request).
2. `GET <gateway>/nfc/t/<id>` with `X-Tag-Key`. On a network error, timeout or 5xx, try
   the backup copy; if that fails too, "This tag can't be reached right now." + Retry.
3. Show the name and one **Run** button (the label for `open_url`, "Show" for `note`,
   "Log" for `log`). Nothing runs before the tap.
4. On tap: `POST <gateway>/nfc/t/<id>/run` with `X-Tag-Key`, a fresh `Idempotency-Key`,
   `Content-Type: application/json` and body `{}`. For `open_url`, navigate in the same
   tap and send the run with `keepalive: true`.
