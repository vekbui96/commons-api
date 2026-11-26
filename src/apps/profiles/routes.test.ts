import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AppKv } from "../../core";
import { createProfilesRouter, DEFAULT_REPO } from "./routes";
import { normaliseName } from "./model";

const TOKEN = "test-token-value";

function memoryKv(): AppKv {
  const store = new Map<string, string>();
  return {
    get: <T>(key: string) => (store.has(key) ? (JSON.parse(store.get(key)!) as T) : undefined),
    set: (key, value) => void store.set(key, JSON.stringify(value)),
    delete: (key) => store.delete(key),
    keys: () => [...store.keys()].sort(),
  };
}

/** A fake GitHub contents API holding one file. */
function fakeGitHub(opts: { status?: number; initial?: string | null; conflictOnce?: boolean } = {}) {
  let file: { text: string; sha: string } | null =
    opts.initial === null ? null : { text: opts.initial ?? "old\n", sha: "sha-0" };
  let conflict = opts.conflictOnce ?? false;
  const calls: { method: string; url: string; auth: string | null; body?: Record<string, unknown> }[] = [];
  let n = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, auth: headers.get("authorization"), body });
    if (opts.status) return new Response(JSON.stringify({ message: "nope" }), { status: opts.status });
    if (method === "GET") {
      if (!file) return new Response("{}", { status: 404 });
      const content = Buffer.from(file.text)
        .toString("base64")
        .replace(/(.{20})/g, "$1\n");
      return Response.json({ sha: file.sha, encoding: "base64", content });
    }
    if (conflict) {
      conflict = false;
      file = { text: "someone else\n", sha: "sha-x" };
      return new Response("{}", { status: 409 });
    }
    if (file && body?.sha !== file.sha) return new Response("{}", { status: 409 });
    n += 1;
    file = { text: Buffer.from(String(body!.content), "base64").toString("utf8"), sha: `sha-${n}` };
    return Response.json({ commit: { sha: `commit-${n}` } }, { status: file ? 200 : 201 });
  }) as typeof fetch;
  return { fn, calls, file: () => file };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function setup(env: Record<string, string> = {}, github = fakeGitHub()) {
  const kv = memoryKv();
  const logs: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/p",
    createProfilesRouter({
      kv,
      env: (name) => env[name],
      fetch: github.fn,
      now: () => new Date("2026-11-25T12:00:00.000Z"),
      log: (m) => logs.push(m),
    }),
  );
  const listener = app.listen(0, "127.0.0.1");
  servers.push(listener);
  await new Promise((resolve) => listener.once("listening", resolve));
  const { port } = listener.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/p`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
  };
  return { kv, call, github, logs };
}

const ZOE = { name: "Zoë", aliases: ["Zo"], inheritsGuest: false, apps: ["units"] };

describe("profiles: draft", () => {
  it("seeds the iteration-1 content, not dirty", async () => {
    const { call } = await setup();
    const res = await call("GET", "/profiles");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json).toEqual({
      ok: true,
      revision: 1,
      updatedAt: "2026-11-25T12:00:00.000Z",
      dirty: false,
      guest: { apps: ["portfolio"] },
      profiles: [
        { id: "tammy", name: "Tammy", aliases: [], inheritsGuest: true, apps: ["units", "cardlens"] },
      ],
    });
  });

  it("creates (201), updates (200) and deletes a profile, bumping the revision", async () => {
    const { call } = await setup();
    const created = await call("PUT", "/profiles/zoe", ZOE);
    expect(created.status).toBe(201);
    expect(created.json.revision).toBe(2);
    expect(created.json.dirty).toBe(true);
    expect(created.json.profiles[1]).toEqual({ id: "zoe", ...ZOE });

    const updated = await call("PUT", "/profiles/zoe", { ...ZOE, name: "  Zoe  ", aliases: [" Z "] });
    expect(updated.status).toBe(200);
    expect(updated.json.revision).toBe(3);
    expect(updated.json.profiles[1]).toMatchObject({ name: "Zoe", aliases: ["Z"] });

    // Same content again: no new revision.
    expect((await call("PUT", "/profiles/zoe", { ...ZOE, name: "Zoe", aliases: ["Z"] })).json.revision).toBe(
      3,
    );

    const deleted = await call("DELETE", "/profiles/zoe");
    expect(deleted.status).toBe(200);
    expect(deleted.json.revision).toBe(4);
    // Back to the published content: not dirty.
    expect(deleted.json.dirty).toBe(false);
    expect((await call("DELETE", "/profiles/zoe")).json).toEqual({ ok: false, error: "profile_not_found" });
  });

  it("defaults aliases to [] and inheritsGuest to true", async () => {
    const { call } = await setup();
    const res = await call("PUT", "/profiles/ann", { name: "Ann", apps: [] });
    expect(res.json.profiles[1]).toEqual({
      id: "ann",
      name: "Ann",
      aliases: [],
      inheritsGuest: true,
      apps: [],
    });
  });

  it("sets the guest apps", async () => {
    const { call } = await setup();
    const res = await call("PUT", "/guest", { apps: ["portfolio", "units"] });
    expect(res.status).toBe(200);
    expect(res.json.guest).toEqual({ apps: ["portfolio", "units"] });
    expect((await call("PUT", "/guest", { apps: ["x", "x"] })).json).toMatchObject({
      error: "invalid_guest",
      problems: [expect.stringMatching(/twice/)],
    });
    expect((await call("PUT", "/guest", [])).status).toBe(400);
  });

  it("reserves guest", async () => {
    const { call } = await setup();
    expect((await call("PUT", "/profiles/guest", { name: "G", apps: [] })).json.error).toBe("guest_reserved");
    expect((await call("DELETE", "/profiles/guest")).json.error).toBe("guest_reserved");
    const alias = await call("PUT", "/profiles/ann", { name: "Ann", aliases: ["GUEST"], apps: [] });
    expect(alias.status).toBe(400);
    expect(alias.json.problems).toEqual([expect.stringMatching(/"guest" already picks the guest view/)]);
  });

  it("rejects bad profiles, listing every problem", async () => {
    const { call } = await setup();
    const res = await call("PUT", `/profiles/${"a".repeat(33)}`, {
      id: "other",
      name: "x".repeat(41),
      aliases: ["", 3],
      inheritsGuest: "yes",
      apps: ["Bad Id", "u", "u"],
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_profile");
    expect(res.json.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^id must be kebab-case/),
        expect.stringMatching(/id in the body/),
        expect.stringMatching(/^name must be 1-40/),
        expect.stringMatching(/aliases has a bad name: ""/),
        expect.stringMatching(/aliases has a bad name: 3/),
        expect.stringMatching(/inheritsGuest/),
        expect.stringMatching(/bad app id: "Bad Id"/),
        expect.stringMatching(/lists "u" twice/),
      ]),
    );
    expect((await call("PUT", "/profiles/Not-Kebab", { name: "A", apps: [] })).status).toBe(400);
    expect((await call("PUT", "/profiles/ann", { apps: [] })).json.problems).toEqual([
      expect.stringMatching(/^name/),
    ]);
  });

  it("rejects names that would pick two profiles (normalised)", async () => {
    const { call } = await setup();
    const res = await call("PUT", "/profiles/tam", { name: "TÂMMY ", apps: [] });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "invalid_profiles" });
    expect(res.json.problems).toEqual([expect.stringMatching(/"tammy" already picks profile "tammy"/)]);
    // An alias equal to the profile's own name is fine.
    expect(
      (await call("PUT", "/profiles/tammy", { name: "Tammy", aliases: ["tammy"], apps: [] })).status,
    ).toBe(200);
  });

  it("normalises like the front end", () => {
    expect(normaliseName("  ZOË  ")).toBe("zoe");
    expect(normaliseName("Mary   Ann")).toBe("mary ann");
  });
});

describe("profiles: export", () => {
  it("returns the exact file in the iteration-1 shape plus revision", async () => {
    const { call } = await setup();
    const res = await call("GET", "/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="profiles.json"');
    expect(res.text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(res.text)).toEqual({
      version: 1,
      revision: 1,
      guest: { apps: ["portfolio"] },
      profiles: [
        { id: "tammy", name: "Tammy", aliases: [], inheritsGuest: true, apps: ["units", "cardlens"] },
      ],
    });
    expect(Object.keys(JSON.parse(res.text))).toEqual(["version", "revision", "guest", "profiles"]);
  });
});

describe("profiles: publish", () => {
  it("is not configured without the token", async () => {
    const { call, github } = await setup();
    const status = await call("GET", "/publish");
    expect(status.json).toEqual({
      ok: true,
      configured: false,
      repo: DEFAULT_REPO,
      path: "profiles.json",
      branch: "main",
      url: "https://vekbui96.github.io/commons-profiles/profiles.json",
      revision: 1,
      dirty: false,
      lastPublished: null,
      lastAttemptAt: null,
      lastError: null,
    });
    expect((await call("POST", "/publish")).json).toEqual({ ok: false, error: "publish_not_configured" });
    expect(github.calls).toEqual([]);
  });

  it("treats a malformed repo as not configured", async () => {
    const { call } = await setup({ COMMONS_PROFILES_TOKEN: TOKEN, COMMONS_PROFILES_REPO: "not a repo" });
    expect((await call("GET", "/publish")).json).toMatchObject({ configured: false, repo: null, url: null });
    expect((await call("POST", "/publish")).status).toBe(503);
  });

  it("writes the export to the repo and records it", async () => {
    const { call, github, logs } = await setup({ COMMONS_PROFILES_TOKEN: TOKEN });
    await call("PUT", "/profiles/zoe", ZOE);
    const exported = (await call("GET", "/export")).text;
    const res = await call("POST", "/publish", { revision: 2 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      configured: true,
      revision: 2,
      dirty: false,
      unchanged: false,
      lastPublished: { revision: 2, publishedAt: "2026-11-25T12:00:00.000Z", commitSha: "commit-1" },
      lastError: null,
    });
    expect(github.file()?.text).toBe(exported);
    const put = github.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://api.github.com/repos/vekbui96/commons-profiles/contents/profiles.json");
    expect(put.body).toMatchObject({ branch: "main", sha: "sha-0" });
    expect(put.auth).toBe(`Bearer ${TOKEN}`);
    // The token is never echoed or logged.
    expect(res.text).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);

    // Publishing the same bytes again makes no commit.
    const again = await call("POST", "/publish");
    expect(again.json).toMatchObject({ unchanged: true, lastPublished: { commitSha: "commit-1" } });
    expect(github.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("creates the file when it does not exist, and retries a conflict once", async () => {
    const created = await setup({ COMMONS_PROFILES_TOKEN: TOKEN }, fakeGitHub({ initial: null }));
    expect((await created.call("POST", "/publish")).status).toBe(200);
    expect(created.github.calls.find((c) => c.method === "PUT")!.body).not.toHaveProperty("sha");

    const raced = await setup({ COMMONS_PROFILES_TOKEN: TOKEN }, fakeGitHub({ conflictOnce: true }));
    expect((await raced.call("POST", "/publish")).status).toBe(200);
    expect(raced.github.calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
  });

  it("refuses a stale revision", async () => {
    const { call, github } = await setup({ COMMONS_PROFILES_TOKEN: TOKEN });
    expect((await call("POST", "/publish", { revision: 7 })).json).toEqual({
      ok: false,
      error: "revision_mismatch",
      revision: 1,
    });
    expect(github.calls).toEqual([]);
  });

  it("records a GitHub failure with a code only, and stays dirty", async () => {
    const { call } = await setup({ COMMONS_PROFILES_TOKEN: TOKEN }, fakeGitHub({ status: 401 }));
    await call("PUT", "/profiles/zoe", ZOE);
    const res = await call("POST", "/publish");
    expect(res.status).toBe(502);
    expect(res.json).toEqual({
      ok: false,
      error: "publish_failed",
      reason: "github_unauthorized",
      status: 401,
    });
    expect(res.text).not.toContain("nope");
    const status = (await call("GET", "/publish")).json;
    expect(status).toMatchObject({
      dirty: true,
      lastPublished: null,
      lastAttemptAt: "2026-11-25T12:00:00.000Z",
      lastError: { error: "github_unauthorized", status: 401, at: "2026-11-25T12:00:00.000Z" },
    });
  });

  it("reports an unreachable GitHub", async () => {
    const failing = {
      fn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      calls: [],
      file: () => null,
    };
    const { call } = await setup({ COMMONS_PROFILES_TOKEN: TOKEN }, failing);
    expect((await call("POST", "/publish")).json).toMatchObject({ reason: "github_unreachable" });
  });
});
