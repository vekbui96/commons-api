# echo (test fixture app)

The smallest app router, used only by `test/server.test.ts`. Never mounted in production (it lives under `test/fixtures`, not `src/apps`).

- **Routes:** `GET /ping` returns `{ app, pong: true }`; `PUT /note` and `GET /note` round-trip a JSON value through KV. The PUT exists only in tests: no write routes ship until auth exists.
- **Data:** KV key `note`. No tables, no migrations.
- **Imports:** this folder and `src/core` (its public `index.ts`) only.
- **Test:** `npx vitest run test/server.test.ts`.
