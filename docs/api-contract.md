# Commons API contract

The agreement between the **Commons Front End** (`vekbui96/commons`) and the
**Commons API** (`vekbui96/commons-api`). This file is kept identical in both
repos: change it in both, in the same piece of work.

## Base URL

- The front end reads the API base from the build-time variable
  `VITE_COMMONS_API` (for example `https://<funnel-host>:10000`, no trailing
  slash). Every call goes through `src/api/client.ts`.
- **Unset (today) means there is no backend**: the client reports
  `hasApi() === false` and no backend feature may be shown or called.
- The API is not deployed yet, so `VITE_COMMONS_API` is unset on Pages.
- Never put a secret in a `VITE_` variable; it ends up in the public bundle.

## CORS

- Allowed origin in production: exactly `https://vekbui96.github.io`.
- Outside production (`NODE_ENV` not `production`) also `http://localhost:*` and
  `http://127.0.0.1:*`.
- Requests send and accept `application/json`. No cookies or credentials yet.

## Core endpoints

### `GET /api/health`

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

### Unknown `/api/*` paths

`404` with `{ "error": "not_found" }`.

## App endpoints

- An app's backend lives at **`/api/apps/<id>/`**, where `<id>` is the same
  kebab-case id as the front-end app folder (`src/apps/<id>/`).
- The front end builds these URLs with `appApiUrl(id, path)` from the client.
- What sits under that prefix is up to each app; document it in the app's
  folder in both repos.

## Key-value storage

- Each app gets a key-value store on the server, scoped to its id (JSON values).
- **No KV endpoint is exposed over HTTP yet.** Apps use the store inside their
  own routes. A generic KV endpoint needs auth first.

## Not yet

- Auth (needed for `private` apps and any write endpoint).
- A deployed URL.
