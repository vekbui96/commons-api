import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_HEADERS, start } from "./helpers";

// The real src/apps, mounted through discovery (core security in front), as in production.
const SRC_APPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "apps");

describe("server-map behind core security", () => {
  let dir = "";
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "server-map-int-"));
    saved = process.env.COMMONS_ARCH_PATH;
    process.env.COMMONS_ARCH_PATH = path.join(dir, "missing.json");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.COMMONS_ARCH_PATH;
    else process.env.COMMONS_ARCH_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is owner only", async () => {
    const { base } = await start({}, { appsDir: SRC_APPS });
    const url = `${base}/api/apps/server-map/architecture`;
    expect((await fetch(url)).status).toBe(401);
    const other = await fetch(url, {
      headers: { ...OWNER_HEADERS, "Tailscale-User-Login": "x@example.test" },
    });
    expect(other.status).toBe(403);
    // The owner gets through to the app (no file yet: 503 map_not_ready, without the path).
    const res = await fetch(url, { headers: OWNER_HEADERS });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: "map_not_ready" });
    expect(text).not.toContain(dir);
  });
});
