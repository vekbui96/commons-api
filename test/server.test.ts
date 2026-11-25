import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from "../src/core/db";
import { createKv } from "../src/core/kv";
import { discoverApps } from "../src/core/apps";
import { loadConfig, PAGES_ORIGIN, PRIVATE_ORIGIN } from "../src/config";
import { FIXTURE_APPS, OWNER_HEADERS, TOKEN, start } from "./helpers";

describe("GET /api/health", () => {
  it("reports ok with the schema version", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      service: "commons",
      db: "ok",
      schemaVersion: MIGRATIONS.length,
      apps: ["echo"],
    });
  });

  it("returns JSON 404 for unknown api paths", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  it("allows the Pages origin", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/health`, { headers: { Origin: PAGES_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES_ORIGIN);
  });

  it("rejects other origins", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows localhost only outside production", () => {
    const matches = (origins: (string | RegExp)[], o: string) =>
      origins.some((x) => (typeof x === "string" ? x === o : x.test(o)));
    expect(matches(loadConfig({ NODE_ENV: "development" }).allowedOrigins, "http://localhost:5180")).toBe(
      true,
    );
    expect(matches(loadConfig({ NODE_ENV: "production" }).allowedOrigins, "http://localhost:5180")).toBe(
      false,
    );
    expect(loadConfig({ NODE_ENV: "production" }).allowedOrigins).toEqual([PRIVATE_ORIGIN, PAGES_ORIGIN]);
  });
});

describe("app routers", () => {
  it("mounts each app's router under /api/apps/<id>/", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/apps/echo/ping`, { headers: OWNER_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app: "echo", pong: true });
    // Not at the root.
    expect((await fetch(`${base}/ping`)).status).toBe(404);
  });

  it("gives each app its own KV scope", async () => {
    const { base, db } = await start();
    const put = await fetch(`${base}/api/apps/echo/note`, {
      method: "PUT",
      headers: {
        ...OWNER_HEADERS,
        "Content-Type": "application/json",
        Origin: PAGES_ORIGIN,
        "X-Commons-Token": TOKEN,
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(put.status).toBe(200);
    const got = await fetch(`${base}/api/apps/echo/note`, { headers: OWNER_HEADERS });
    expect(await got.json()).toEqual({ note: { text: "hi" } });
    expect(createKv(db, "echo").get("note")).toEqual({ text: "hi" });
    expect(createKv(db, "other").get("note")).toBeUndefined();
  });

  it("finds compiled routes.js files (the production build)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "commons-dist-"));
    try {
      mkdirSync(path.join(dir, "built"));
      writeFileSync(path.join(dir, "built", "routes.js"), "export default () => null;");
      const apps = await discoverApps(dir);
      expect(apps.map((a) => a.id)).toEqual(["built"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds no apps in a missing folder", async () => {
    expect(await discoverApps(path.join(FIXTURE_APPS, "does-not-exist"))).toEqual([]);
  });
});

describe("database migration", () => {
  it("creates the app_kv table on a fresh file and is idempotent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "commons-db-"));
    const file = path.join(dir, "nested", "commons.db");
    try {
      const db = openDatabase(file);
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      const cols = (db.prepare("PRAGMA table_info(app_kv)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(["app_id", "key", "value", "updated_at"]);
      expect(migrate(db)).toBe(MIGRATIONS.length);
      db.close();

      // Re-opening keeps data and does not re-run migrations.
      const again = openDatabase(file);
      createKv(again, "units").set("last", 3);
      again.close();
      const third = new DatabaseSync(file);
      expect(schemaVersion(third)).toBe(MIGRATIONS.length);
      expect(createKv(third, "units").get("last")).toBe(3);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports set, overwrite, delete and keys", () => {
    const kv = createKv(openDatabase(":memory:"), "app");
    kv.set("a", 1);
    kv.set("b", { x: true });
    kv.set("a", 2);
    expect(kv.get("a")).toBe(2);
    expect(kv.keys()).toEqual(["a", "b"]);
    expect(kv.delete("a")).toBe(true);
    expect(kv.delete("a")).toBe(false);
    expect(kv.keys()).toEqual(["b"]);
  });
});
