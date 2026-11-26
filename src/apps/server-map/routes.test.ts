import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServerMapRouter, MAX_BYTES } from "./routes";

const VALID = {
  schema: 1,
  generatedAt: "2026-11-25T12:00:00Z",
  host: "server-pc",
  layers: ["edge", "services"],
  nodes: [{ id: "a", kind: "service", layer: "services", name: "A", status: "ok", details: {}, links: [] }],
  edges: [],
  drift: [],
  sources: [{ name: "nssm", ok: true }],
};

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "server-map-"));
  dirs.push(dir);
  const file = path.join(dir, "architecture.json");
  const app = express();
  app.use(
    "/api/apps/server-map",
    createServerMapRouter(() => file),
  );
  const listener = app.listen(0, "127.0.0.1");
  servers.push(listener);
  await new Promise((resolve) => listener.once("listening", resolve));
  const { port } = listener.address() as AddressInfo;
  const get = () => fetch(`http://127.0.0.1:${port}/api/apps/server-map/architecture`);
  return { dir, file, get };
}

async function expectError(res: Response, status: number, error: string, dir: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ ok: false, error });
  // No path or file system detail leaks.
  expect(text).not.toContain(dir);
  expect(text).not.toMatch(/architecture\.json|ENOENT|EACCES|[A-Z]:\\|\//);
}

describe("GET /api/apps/server-map/architecture", () => {
  it("returns the file as is", async () => {
    const { file, get } = await setup();
    const raw = JSON.stringify(VALID, null, 2);
    writeFileSync(file, raw);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(raw);
  });

  it("answers 503 map_not_ready when the file is missing", async () => {
    const { dir, get } = await setup();
    await expectError(await get(), 503, "map_not_ready", dir);
  });

  it("answers 502 map_invalid for bad JSON", async () => {
    const { dir, file, get } = await setup();
    writeFileSync(file, "{ not json");
    await expectError(await get(), 502, "map_invalid", dir);
  });

  it("answers 502 map_invalid when schema is not 1 or nodes/edges are not arrays", async () => {
    const { dir, file, get } = await setup();
    for (const bad of [
      { ...VALID, schema: 2 },
      { ...VALID, nodes: {} },
      { ...VALID, edges: null },
      [VALID],
    ]) {
      writeFileSync(file, JSON.stringify(bad));
      // A fresh mtime so the cache sees each version.
      const t = new Date(Date.now() + Math.random() * 1e6);
      utimesSync(file, t, t);
      await expectError(await get(), 502, "map_invalid", dir);
    }
  });

  it("answers 502 map_invalid for a file over 1 MB", async () => {
    const { dir, file, get } = await setup();
    const pad = "x".repeat(MAX_BYTES);
    writeFileSync(file, JSON.stringify({ ...VALID, pad }));
    await expectError(await get(), 502, "map_invalid", dir);
  });

  it("picks up a rewritten file", async () => {
    const { file, get } = await setup();
    writeFileSync(file, JSON.stringify(VALID));
    expect((await get()).status).toBe(200);
    writeFileSync(file, JSON.stringify({ ...VALID, schema: 0, host: "changed-size" }));
    const t = new Date(Date.now() + 5000);
    utimesSync(file, t, t);
    expect((await get()).status).toBe(502);
  });
});
