# Commons API contract

The agreement between the **Commons Front End** (`vekbui96/commons`) and the
**Commons API** (`vekbui96/commons-api`). This file is kept identical in both
repos: change it in both, in the same piece of work.

## Where it runs

- The API runs on server-pc as the NSSM service `commons-api`: node on the
  compiled build, listening on **`127.0.0.1:8790` only**.
- **The private Commons is `https://server-pc.tail0e4194.ts.net:8445/`**,
  reachable **only on Ve's tailnet** through `tailscale serve`. It is **never on
  Funnel** and never on the public internet. On that origin:
  - `/` serves the private front-end build from the static folder
    `D:\services\commons-web\`.
  - `/api` is proxied to `http://127.0.0.1:8790/api`. The proxy target keeps
    the `/api` path (without it, `--set-path=/api` strips the mount), so
    `GET https://…:8445/api/health` reaches the server's `/api/health` unchanged.
- Code is public; data stays on server-pc (`D:\services\commons-api\data\`).

## Base URL

- Every call goes through the front end's `src/api/client.ts`.
- **Private build** (served from 8445): the API is on the **same origin**, so
  calls go to relative `/api/...`.
- **Public build** (GitHub Pages): the API base comes from the build-time
  variable `VITE_COMMONS_API` (no trailing slash), for example
  `https://server-pc.tail0e4194.ts.net:8445`. Unset means there is no backend:
  `hasApi() === false` and no backend feature may be shown or called.
- Never put a secret in a `VITE_` variable; it ends up in the public bundle.

## Reachability

- `GET /api/health` needs no identity. The front end uses it to decide whether
  private features show: a timeout, network error, CORS failure or non-`ok`
  answer means "not reachable" (off the tailnet the host does not answer), and
  the UI shows a quiet "connect to Tailscale" state, never an error.

## Security

### Origins

- Allowed browser origins:
  - `https://server-pc.tail0e4194.ts.net:8445` (the private site, same origin);
  - `https://vekbui96.github.io` (the public Pages site, for optional private
    features when Ve is on the tailnet).
  - Outside production (`NODE_ENV` not `production`) also `http://localhost:*`
    and `http://127.0.0.1:*`.
- **Any request whose `Origin` header is present and not allowed is refused**
  with `403 { "error": "origin_not_allowed" }`, on every `/api` path, health
  included. A request with no `Origin` (curl, same-origin GET) passes this check.
- An allowed cross-origin request gets `Access-Control-Allow-Origin: <origin>`
  and `Vary: Origin`. No cookies or credentials are used
  (`Access-Control-Allow-Credentials` is never sent); identity comes from the
  tailnet, not the browser.
- Preflights (`OPTIONS` with `Access-Control-Request-Method`) from an allowed
  origin answer `204` with `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE`,
  `Access-Control-Allow-Headers: Content-Type, X-Commons-Token` and
  `Access-Control-Max-Age: 600`. When the Pages origin sends
  `Access-Control-Request-Private-Network: true`, the answer adds
  **`Access-Control-Allow-Private-Network: true`** (Chrome's Private Network
  Access). Preflights need no identity.

### Identity

- `tailscale serve` adds the Tailscale identity headers (`Tailscale-User-Login`,
  `Tailscale-User-Name`, …) for tailnet clients and overwrites any copy the
  client sends.
- The API trusts them **only because it listens on 127.0.0.1**, and in
  production only when the TCP peer is the Tailscale service itself (a local
  process dialling 127.0.0.1 with a forged header is refused), the same model as
  the ops hub's action server.
- The owner login is configuration, **never in the repo**: `COMMONS_OWNER_LOGIN`
  if set, otherwise the login that owns the node, read at start from
  `tailscale status --json` and cached in `D:\services\commons-api\data\identity.json`.
- **`/api/health` needs no identity. Everything under `/api/apps/` and
  `/api/session` requires the owner's identity:**

  | Status | `error`              | When                                                                         |
  | ------ | -------------------- | ---------------------------------------------------------------------------- |
  | `401`  | `identity_required`  | no `Tailscale-User-Login` (not through `tailscale serve`)                    |
  | `403`  | `not_owner`          | a tailnet user other than the owner                                          |
  | `403`  | `self_request`       | from server-pc itself, or not forwarded by serve (see below)                 |
  | `403`  | `wrong_host`         | `Host` is not `server-pc.tail0e4194.ts.net:8445`                             |
  | `403`  | `not_via_tailscale`  | the TCP peer is not the Tailscale service                                    |
  | `503`  | `identity_not_ready` | the owner login is not known yet (just after boot, before tailscale answers) |

- **Requests from server-pc itself are refused**, as the hub does: serve adds
  the owner's login to them too, so the API refuses any identity request whose
  `X-Forwarded-For` is one of this node's tailnet IPs (or is missing). The
  unattended loops on this box therefore cannot act through the API. Use the
  private site from a phone or laptop. Loopback calls to `/api/health` work.

### Writes and CSRF

- Writes (`POST`, `PUT`, `PATCH`, `DELETE`) under the owner-only paths need,
  besides the identity:
  - an `Origin` header that is allowed (missing or not allowed:
    `403 { "error": "origin_required" }`), **and**
  - the CSRF token in the **`X-Commons-Token`** header (missing or wrong:
    `403 { "error": "csrf_token_invalid" }`).
- The token comes from `GET /api/session`. It is random per API process: after a
  restart the old token gets `csrf_token_invalid`, and the client fetches a new
  session and retries once.

## Core endpoints

### `GET /api/health` (open)

`200` when the database answers, `503` otherwise.

```json
{
  "ok": true,
  "service": "commons",
  "db": "ok",
  "schemaVersion": 1,
  "apps": ["<id>", "..."]
}
```

`db` is `"ok"` or `"error"`; `schemaVersion` is a number (or `null` on error);
`apps` lists the ids of the app routers mounted.

### `GET /api/session` (owner only)

`200`, `Cache-Control: no-store`:

```json
{ "ok": true, "login": "<the owner's tailnet login>", "csrfToken": "<64 hex chars>" }
```

Errors as in the identity table above.

### Unknown `/api/*` paths

`404` with `{ "error": "not_found" }`. Under `/api/apps/` the identity checks
come first.

## App endpoints

- An app's backend lives at **`/api/apps/<id>/`**, where `<id>` is the same
  kebab-case id as the front-end app folder (`src/apps/<id>/`).
- Everything under `/api/apps/` is owner only, and its writes need the CSRF
  token (see Security). The core enforces this before any app router runs.
- The front end builds these URLs with `appApiUrl(id, path)` from the client.
- What sits under that prefix is up to each app; document it in the app's
  folder in both repos.

### `server-map`: `GET /api/apps/server-map/architecture` (owner only)

The live server architecture map. The ops hub writes it to a file on server-pc
(`COMMONS_ARCH_PATH`, default `D:\hub\state\architecture.json`); the API
returns that file **as is**, read-only, never writing it.

- `200`, `Content-Type: application/json`, `Cache-Control: no-store`: the map
  (schema v1, below).
- Errors (also `Cache-Control: no-store`; never a file path or file system
  message):

  | Status | Body                                        | When                                                                          |
  | ------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
  | `503`  | `{ "ok": false, "error": "map_not_ready" }` | the file does not exist yet (or cannot be read right now)                     |
  | `502`  | `{ "ok": false, "error": "map_invalid" }`   | not valid JSON, `schema` is not `1`, `nodes`/`edges` not arrays, or over 1 MB |

  Identity errors (see Security) come first.

Schema v1 (a shared contract between the hub and the front end; the API checks
only the top level: `schema === 1`, `nodes` and `edges` arrays):

```
{
  schema: 1, generatedAt, host, layers: [...],
  nodes: [{ id, kind, layer, name, description?, status, statusDetail?, details: {}, links: [], documented, group? }],
  edges: [{ from, to, kind, label? }],
  drift: [{ nodeId?, message }],
  sources: [{ name, ok, error? }]
}
```

### `profiles`: visitor profiles editor (owner only)

The private editor for the visitor profiles the **public** site reads. Edits
are a **draft** on server-pc until **published**: publishing writes
`profiles.json` to the public data repo `vekbui96/commons-profiles` (branch
`main`), which Pages serves at
`https://vekbui96.github.io/commons-profiles/profiles.json`. Profiles are
tailoring, never access control.

All under `/api/apps/profiles/`. Every answer has `Cache-Control: no-store`.
Identity, Origin and CSRF errors (see Security) come first; writes need the
CSRF token like any app write.

**Profile** (the iteration-1 shape, keys in this order):

```json
{ "id": "tammy", "name": "Tammy", "aliases": [], "inheritsGuest": true, "apps": ["units", "cardlens"] }
```

**Rules** (the same as the front end's `parseProfiles`, plus limits):

- `id`: kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), 32 characters or fewer; fixed
  once created (rename = delete + create).
- `name`: 1-40 characters after trimming. `aliases`: up to 10 names, each 1-40
  characters after trimming (stored trimmed).
- Every id, name and alias, normalised (NFD, accents dropped, lower case,
  trimmed, spaces collapsed), picks **one** profile across all profiles, and
  none may be `guest` (reserved for the guest view). Repeats inside one profile
  are fine.
- `apps`: up to 50 unique kebab-case app ids (64 characters or fewer). Plain
  strings: the API does not check them against the registry; the UI offers
  public apps only.
- At most 100 profiles. `guest` is not a profile and cannot be deleted.

**Draft state** (`GET /profiles`, and the answer to every successful edit):

```json
{
  "ok": true,
  "revision": 3,
  "updatedAt": "2026-11-25T18:00:00.000Z",
  "dirty": true,
  "guest": { "apps": ["portfolio"] },
  "profiles": [
    { "id": "tammy", "name": "Tammy", "aliases": [], "inheritsGuest": true, "apps": ["units", "cardlens"] }
  ]
}
```

- `revision` goes up by one on each edit that changes the content (an edit
  that changes nothing keeps it).
- `dirty`: the draft differs from what was last published.
- First start seeds guest `["portfolio"]` and `tammy` (the iteration-1 file
  already in the data repo), recorded as published, so `dirty` starts `false`.

| Method + path          | Body                                       | Success                                                       |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `GET /profiles`        |                                            | `200` draft state                                             |
| `PUT /profiles/:id`    | `{ name, aliases?, inheritsGuest?, apps }` | `201` (created, appended) or `200` (replaced in place): state |
| `DELETE /profiles/:id` |                                            | `200` draft state                                             |
| `PUT /guest`           | `{ apps }`                                 | `200` draft state                                             |
| `GET /export`          |                                            | `200` the exact file `POST /publish` would write (below)      |
| `GET /publish`         |                                            | `200` publish status                                          |
| `POST /publish`        | optional `{ "revision": n }`               | `200` publish status + `unchanged`                            |

- `PUT /profiles/:id`: `aliases` defaults to `[]`, `inheritsGuest` to `true`;
  an `id` in the body must equal the URL's; unknown body keys are ignored.

**Export** (`GET /export`): `Content-Type: application/json; charset=utf-8`,
`Content-Disposition: attachment; filename="profiles.json"`. The body is the
file exactly (2-space JSON, trailing newline):

```json
{
  "version": 1,
  "revision": 3,
  "guest": { "apps": ["portfolio"] },
  "profiles": [
    { "id": "tammy", "name": "Tammy", "aliases": [], "inheritsGuest": true, "apps": ["units", "cardlens"] }
  ]
}
```

It is the iteration-1 shape that `parseProfiles` accepts, plus a top-level
`revision` (the draft revision published), which `parseProfiles` ignores.
**Readers of the file must ignore unknown top-level keys.** `publishedAt` and
the commit live in the API's publish status, not the file.

**Publish status** (`GET /publish`; `POST /publish` adds `"unchanged": bool`):

```json
{
  "ok": true,
  "configured": true,
  "repo": "vekbui96/commons-profiles",
  "path": "profiles.json",
  "branch": "main",
  "url": "https://vekbui96.github.io/commons-profiles/profiles.json",
  "revision": 3,
  "dirty": false,
  "lastPublished": { "revision": 3, "publishedAt": "2026-11-25T18:05:00.000Z", "commitSha": "<40 hex>" },
  "lastAttemptAt": "2026-11-25T18:05:00.000Z",
  "lastError": null
}
```

- `configured`: the server has a GitHub token. `false` means `POST /publish`
  answers `503`; offer the export download instead. `repo`/`url` are `null`
  when the configured repo name is malformed.
- `lastPublished`: `null` until the API has published once. `commitSha` may be
  `null` when the file already held exactly these bytes (no commit was made;
  `unchanged: true`).
- `lastError`: the last failed attempt, `{ "error": "<reason>", "status"?: <http>, "at" }`,
  cleared by the next success. Reasons: `github_unauthorized` (401),
  `github_forbidden` (403: token lacks access, or rate limit),
  `github_not_found` (404: repo or branch not reachable with this token),
  `github_conflict` (409/422 after one retry), `github_error`,
  `github_unreachable` (network or 15 s timeout).
- `POST /publish` with `revision`: publishes only if it equals the draft
  revision (what the UI is showing). Publishing is plain request/response:
  the answer comes when GitHub has answered. The site picks the new file up
  once Pages rebuilds (usually within a minute or two).

**Errors** (body `{ "ok": false, "error": "<code>", ... }`):

| Status | `error`                  | When                                                                          |
| ------ | ------------------------ | ----------------------------------------------------------------------------- |
| `400`  | `invalid_profile`        | the body or `:id` breaks a profile rule; `problems: string[]` lists them all  |
| `400`  | `invalid_profiles`       | the edit would break a cross-profile rule (name clash); `problems: string[]`  |
| `400`  | `invalid_guest`          | `PUT /guest` body is not `{ apps: [...] }` with valid ids; `problems`         |
| `400`  | `guest_reserved`         | `PUT` or `DELETE /profiles/guest`                                             |
| `404`  | `profile_not_found`      | `DELETE` of an id that does not exist                                         |
| `409`  | `revision_mismatch`      | `POST /publish` with a stale `revision`; body includes the current `revision` |
| `409`  | `publish_in_progress`    | another publish is still running                                              |
| `502`  | `publish_failed`         | GitHub refused or did not answer; `reason` (as `lastError.error`), `status`?  |
| `503`  | `publish_not_configured` | no GitHub token on the server (or a malformed repo name)                      |

`problems` strings are for display, not for matching.

### `nfc-controls`: NFC tag editor (owner only)

The editor half of NFC controls lives at `/api/apps/nfc-controls/`. Its full contract,
including the public gateway `commons-public` and the static backup copy, is
[`docs/nfc-controls-contract.md`](nfc-controls-contract.md), identical in every repo
that uses it. The public gateway is a separate process and never part of this API.

## Key-value storage

- Each app gets a key-value store on the server, scoped to its id (JSON values).
- **No generic KV endpoint is exposed over HTTP.** Apps use the store inside
  their own routes.

## Errors

Every error body is JSON: `{ "error": "<code>" }`, with the codes above. App
endpoints may add `"ok": false` (the `server-map` errors do).
