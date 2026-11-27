import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AppKv } from "../../core";
import { keyHash } from "./model";
import { createNfcRouter } from "./routes";
import { APP_MIGRATIONS, migrateApp } from "./store";

const BACKUP_TOKEN = "test-backup-token-value";

function memoryKv(): AppKv {
  const store = new Map<string, string>();
  return {
    get: <T>(key: string) => (store.has(key) ? (JSON.parse(store.get(key)!) as T) : undefined),
    set: (key, value) => void store.set(key, JSON.stringify(value)),
    delete: (key) => store.delete(key),
    keys: () => [...store.keys()].sort(),
  };
}

/** The gateway's public.db as the contract describes it. */
function gatewayDb(file: string, instance = "instance-0001") {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS public_runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, tag_id TEXT NOT NULL,
      action_type TEXT NOT NULL, code TEXT NOT NULL);`);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('instance', ?)").run(instance);
  const add = db.prepare("INSERT INTO public_runs (at, tag_id, action_type, code) VALUES (?, ?, ?, ?)");
  return {
    add: (tagId: string, type: string, code: string, at = "2026-11-27T12:00:00.000Z") =>
      add.run(at, tagId, type, code),
    raw: db,
    close: () => db.close(),
  };
}

function fakeGitHub() {
  let file: { text: string; sha: string } | null = null;
  const calls: { method: string; auth: string | null }[] = [];
  const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, auth: new Headers(init?.headers).get("authorization") });
    if (method === "GET") {
      if (!file) return new Response("{}", { status: 404 });
      return Response.json({
        sha: file.sha,
        encoding: "base64",
        content: Buffer.from(file.text).toString("base64"),
      });
    }
    const body = JSON.parse(String(init!.body)) as { content: string };
    file = { text: Buffer.from(body.content, "base64").toString("utf8"), sha: `sha-${calls.length}` };
    return Response.json({ commit: { sha: `commit-${calls.length}` } }, { status: 201 });
  }) as typeof fetch;
  return { fn, calls, file: () => file };
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(
  opts: { env?: Record<string, string>; db?: DatabaseSync; kv?: AppKv; fetch?: typeof fetch } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "nfc-"));
  dirs.push(dir);
  const snapshotPath = path.join(dir, "snapshot", "public-tags.json");
  const publicDb = path.join(dir, "public.db");
  const env: Record<string, string> = {
    COMMONS_NFC_SNAPSHOT_PATH: snapshotPath,
    COMMONS_NFC_PUBLIC_DB: publicDb,
    ...opts.env,
  };
  const db = opts.db ?? new DatabaseSync(":memory:");
  const kv = opts.kv ?? memoryKv();
  let clock = new Date("2026-11-27T12:00:00.000Z");
  const pending: (() => void)[] = [];
  const github = fakeGitHub();
  const logs: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/n",
    createNfcRouter({
      db,
      kv,
      env: (n) => env[n],
      fetch: opts.fetch ?? github.fn,
      now: () => clock,
      log: (m) => logs.push(m),
      schedule: (fn) => {
        pending.push(fn);
        return () => pending.splice(pending.indexOf(fn), 1);
      },
    }),
  );
  const listener = app.listen(0, "127.0.0.1");
  servers.push(listener);
  await new Promise((r) => listener.once("listening", r));
  const { port } = listener.address() as AddressInfo;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/n${p}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
  };
  return {
    call,
    db,
    kv,
    logs,
    github,
    snapshot: () => JSON.parse(readFileSync(snapshotPath, "utf8")),
    publicDb,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    flush: async () => {
      for (const fn of pending.splice(0)) fn();
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

const NOTE = { name: "Fridge note", action: { type: "note", params: { title: "Hi", text: "Milk" } } };
const LOG = { name: "Fed the cat", action: { type: "log", params: { label: "Fed" } }, notes: "secret notes" };

describe("nfc-controls: migrations", () => {
  it("run once and survive a second router on the same db", async () => {
    const db = new DatabaseSync(":memory:");
    const kv = memoryKv();
    expect(migrateApp(db, kv)).toBe(APP_MIGRATIONS.length);
    expect(migrateApp(db, kv)).toBe(APP_MIGRATIONS.length);
    const a = await setup({ db, kv });
    await a.call("POST", "/tags", NOTE);
    const b = await setup({ db, kv });
    expect((await b.call("GET", "/tags")).json.tags).toHaveLength(1);
  });
});

describe("nfc-controls: tags", () => {
  it("creates a public tag with a link, never leaking the key elsewhere", async () => {
    const { call, snapshot } = await setup();
    const res = await call("POST", "/tags", LOG);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tag = res.json.tag;
    expect(tag).toMatchObject({
      name: "Fed the cat",
      enabled: true,
      notes: "secret notes",
      action: { type: "log", params: { label: "Fed" } },
      public: true,
      inBackup: false,
      revision: 1,
      count: 0,
      runCount: 0,
      lastRun: null,
    });
    expect(tag.id).toMatch(/^[a-z0-9]{12}$/);
    const key = new URL(tag.publicLink.replace("#/t/", "t/")).searchParams.get("k")!;
    expect(tag.publicLink).toBe(`https://vekbui96.github.io/commons/#/t/${tag.id}?k=${key}`);
    expect(key).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const snap = snapshot();
    expect(snap.tags).toEqual([
      { id: tag.id, name: "Fed the cat", keyHash: keyHash(key), action: tag.action },
    ]);
    expect(JSON.stringify(snap)).not.toContain(key);
    expect(JSON.stringify(snap)).not.toContain("secret notes");

    const list = await call("GET", "/tags");
    expect(list.json.tags[0]).not.toHaveProperty("notes");
  });

  it("claims an id, refuses a taken one and validates", async () => {
    const { call } = await setup();
    expect((await call("POST", "/tags", { ...NOTE, id: "fridge" })).json.tag.id).toBe("fridge");
    expect((await call("POST", "/tags", { ...NOTE, id: "fridge" })).json).toEqual({
      ok: false,
      error: "tag_exists",
    });
    const bad = await call("POST", "/tags", { name: "", action: { type: "note", params: {} } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_tag");
    expect(bad.json.problems.length).toBeGreaterThan(0);
    const unknown = await call("POST", "/tags", { name: "x", action: { type: "forward" } });
    expect(unknown.json.error).toBe("unknown_action_type");
    expect((await call("GET", "/tags/nope")).status).toBe(404);
    expect((await call("GET", "/tags/NOT%20AN%20ID")).json.error).toBe("tag_not_found");
  });

  it("replaces with revision checks, resets count on type change, and audits field names only", async () => {
    const { call, db } = await setup();
    const id = (await call("POST", "/tags", LOG)).json.tag.id;
    const stale = await call("PUT", `/tags/${id}`, { ...LOG, name: "New", revision: 9 });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ ok: false, error: "revision_mismatch", revision: 1 });
    const ok = await call("PUT", `/tags/${id}`, { ...LOG, name: "New", revision: 1 });
    expect(ok.json.tag).toMatchObject({ name: "New", revision: 2 });
    // Same content: no new revision.
    expect((await call("PUT", `/tags/${id}`, { ...LOG, name: "New" })).json.tag.revision).toBe(2);
    expect((await call("PUT", `/tags/${id}`, { ...LOG, id: "other" })).status).toBe(400);
    const notes = db.prepare("SELECT op, detail FROM nfc_controls_audit ORDER BY id").all();
    expect(notes).toEqual([
      { op: "create", detail: "name,enabled,notes,action.type,action.params" },
      { op: "update", detail: "name" },
    ]);
    expect(JSON.stringify(notes)).not.toMatch(/New|secret/);
  });

  it("disabling takes the tag out of the snapshot; delete removes it and its runs", async () => {
    const { call, snapshot } = await setup();
    const id = (await call("POST", "/tags", NOTE)).json.tag.id;
    await call("PUT", `/tags/${id}`, { ...NOTE, enabled: false });
    expect(snapshot().tags).toEqual([]);
    await call("PUT", `/tags/${id}`, NOTE);
    expect(snapshot().tags).toHaveLength(1);
    expect((await call("DELETE", `/tags/${id}`)).json).toEqual({ ok: true });
    expect(snapshot().tags).toEqual([]);
    expect((await call("GET", `/tags/${id}`)).status).toBe(404);
  });

  it("rotates the key: new link, new hash, revision up", async () => {
    const { call, snapshot } = await setup();
    const before = (await call("POST", "/tags", NOTE)).json.tag;
    const after = (await call("POST", `/tags/${before.id}/public/rotate`)).json.tag;
    expect(after.publicLink).not.toBe(before.publicLink);
    expect(after.revision).toBe(2);
    const key = after.publicLink.split("?k=")[1];
    expect(snapshot().tags[0].keyHash).toBe(keyHash(key));
  });
});

describe("nfc-controls: public runs (untrusted import)", () => {
  it("imports valid runs, counts log taps, skips malformed rows and unknown tags", async () => {
    const t = await setup();
    const log = (await t.call("POST", "/tags", LOG)).json.tag;
    const note = (await t.call("POST", "/tags", NOTE)).json.tag;
    const g = gatewayDb(t.publicDb);
    g.add(log.id, "log", "counted");
    g.add(log.id, "log", "deduped");
    g.add(log.id, "log", "counted");
    g.add(note.id, "note", "shown");
    g.add("unknown-tag", "log", "counted");
    g.add(log.id, "log", "opened"); // code does not fit the type
    g.add(log.id, "toggle", "counted"); // not a v1 type
    g.add("Bad Id", "log", "counted");
    g.add(log.id, "log", "counted", "not a date");
    g.add(log.id, "log", "counted", "2099-01-01T00:00:00.000Z"); // far future
    g.close();

    const res = await t.call("GET", `/tags/${log.id}`);
    expect(res.json.tag).toMatchObject({ count: 2, runCount: 3 });
    expect(res.json.tag.lastRun).toMatchObject({
      via: "public",
      code: "counted",
      message: "Counted",
      ok: true,
    });
    const runs = (await t.call("GET", "/runs")).json;
    expect(runs.runs.map((r: { code: string }) => r.code)).toEqual([
      "shown",
      "counted",
      "deduped",
      "counted",
    ]);
    expect(runs.nextBefore).toBeNull();
    expect(t.logs.some((l) => l.includes("skipped 5 malformed"))).toBe(true);

    // Cursor: nothing is imported twice.
    t.advance(10000);
    expect((await t.call("GET", `/tags/${log.id}`)).json.tag.runCount).toBe(3);

    // Reset clears only the count.
    const reset = (await t.call("POST", `/tags/${log.id}/reset`)).json.tag;
    expect(reset).toMatchObject({ count: 0, runCount: 3 });
  });

  it("starts over when the gateway database is new, and survives a missing file", async () => {
    const t = await setup();
    expect((await t.call("GET", "/status")).json.gateway.runs).toEqual({
      configured: true,
      importedAt: "2026-11-27T12:00:00.000Z",
      error: null,
    });
    const log = (await t.call("POST", "/tags", LOG)).json.tag;
    let g = gatewayDb(t.publicDb, "instance-aaaa");
    g.add(log.id, "log", "counted");
    g.close();
    t.advance(10000);
    expect((await t.call("GET", `/tags/${log.id}`)).json.tag.count).toBe(1);
    rmSync(t.publicDb);
    g = gatewayDb(t.publicDb, "instance-bbbb");
    g.add(log.id, "log", "counted");
    g.close();
    t.advance(10000);
    expect((await t.call("GET", `/tags/${log.id}`)).json.tag.count).toBe(2);
  });

  it("reports an unreadable gateway database without failing", async () => {
    const t = await setup();
    const g = new DatabaseSync(t.publicDb);
    g.exec("CREATE TABLE junk (x)");
    g.close();
    const status = (await t.call("GET", "/status")).json;
    expect(status.gateway.runs.error).toMatch(/^import_failed/);
    expect((await t.call("GET", "/tags")).status).toBe(200);
  });

  it("keeps the newest 200 runs or 180 days, whichever is more", async () => {
    const t = await setup();
    const log = (await t.call("POST", "/tags", LOG)).json.tag;
    const g = gatewayDb(t.publicDb);
    g.raw.exec("BEGIN");
    for (let i = 0; i < 250; i++) g.add(log.id, "log", "deduped", "2026-11-26T00:00:00.000Z");
    g.raw.exec("COMMIT");
    await t.call("GET", "/tags");
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM nfc_controls_runs").get()).toEqual({ n: 250 });
    // 200 days later: only the newest 200 old runs stay (plus the new one).
    t.advance(200 * 86400000);
    g.add(log.id, "log", "counted", t.advance(0).toISOString());
    g.close();
    await t.call("GET", "/tags");
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM nfc_controls_runs").get()).toEqual({ n: 200 });
    const page = (await t.call("GET", `/tags/${log.id}/runs?limit=150`)).json;
    expect(page.runs).toHaveLength(150);
    expect(page.nextBefore).toBe(page.runs[149].id);
    const next = (await t.call("GET", `/tags/${log.id}/runs?limit=150&before=${page.nextBefore}`)).json;
    expect(next.runs).toHaveLength(50);
    expect(next.nextBefore).toBeNull();
    expect((await t.call("GET", "/runs?limit=0")).json.error).toBe("invalid_query");
    expect((await t.call("GET", "/runs?before=x")).status).toBe(400);
  });
});

describe("nfc-controls: backup copy", () => {
  it("is not configured without a token", async () => {
    const t = await setup();
    const res = await t.call("POST", "/backup/publish");
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ ok: false, error: "backup_not_configured" });
    expect((await t.call("GET", "/status")).json.backup).toMatchObject({
      configured: false,
      repo: "vekbui96/commons-nfc-tags",
      url: "https://vekbui96.github.io/commons-nfc-tags/tags.json",
    });
  });

  it("publishes after a change (debounced), with the token only in the header", async () => {
    const t = await setup({ env: { COMMONS_NFC_BACKUP_TOKEN: BACKUP_TOKEN } });
    await t.call("POST", "/tags", NOTE);
    await t.call("POST", "/tags", LOG);
    expect((await t.call("GET", "/status")).json.backup).toMatchObject({
      configured: true,
      dirty: true,
      tags: 1,
    });
    await t.flush();
    const status = (await t.call("GET", "/status")).json.backup;
    expect(status).toMatchObject({ dirty: false, tags: 1, lastError: null });
    expect(status.commitSha).toMatch(/^commit-/);
    const file = JSON.parse(t.github.file()!.text);
    expect(Object.keys(file.tags)).toHaveLength(1);
    expect(t.github.file()!.text).not.toMatch(/Fridge|Milk/);
    expect(t.github.calls.every((c) => c.auth === `Bearer ${BACKUP_TOKEN}`)).toBe(true);
    expect(JSON.stringify(status) + t.logs.join("\n")).not.toContain(BACKUP_TOKEN);
    // Manual publish of unchanged content makes no commit.
    const puts = t.github.calls.filter((c) => c.method === "PUT").length;
    expect((await t.call("POST", "/backup/publish")).json.ok).toBe(true);
    expect(t.github.calls.filter((c) => c.method === "PUT").length).toBe(puts);
  });

  it("records a GitHub failure as a code, and a bad repo name as not configured", async () => {
    const down = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch;
    const t = await setup({ env: { COMMONS_NFC_BACKUP_TOKEN: BACKUP_TOKEN }, fetch: down });
    await t.call("POST", "/tags", NOTE);
    const res = await t.call("POST", "/backup/publish");
    expect(res.status).toBe(502);
    expect(res.json).toEqual({
      ok: false,
      error: "backup_failed",
      reason: "github_unauthorized",
      status: 401,
    });
    const status = (await t.call("GET", "/status")).json.backup;
    expect(status.lastError).toMatchObject({ error: "github_unauthorized", status: 401 });
    expect(JSON.stringify(status)).not.toContain("Bad credentials");
    const bad = await setup({
      env: { COMMONS_NFC_BACKUP_TOKEN: BACKUP_TOKEN, COMMONS_NFC_BACKUP_REPO: "bad repo" },
    });
    expect((await bad.call("POST", "/backup/publish")).status).toBe(503);
  });
});
