import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_HEADERS, start, TOKEN } from "./helpers";

// The real src/apps, mounted through discovery (core security in front), as in production.
const SRC_APPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "apps");
const PRIVATE = "https://server-pc.tail0e4194.ts.net:8445";

describe("nfc-controls behind core security", () => {
  it("is owner only, and writes need Origin + CSRF", async () => {
    const { base } = await start({}, { appsDir: SRC_APPS });
    const url = `${base}/api/apps/nfc-controls/tags`;
    expect((await fetch(url)).status).toBe(401);
    const other = await fetch(url, {
      headers: { ...OWNER_HEADERS, "Tailscale-User-Login": "x@example.test" },
    });
    expect(other.status).toBe(403);
    expect(await (await fetch(url, { headers: OWNER_HEADERS })).json()).toEqual({ ok: true, tags: [] });

    const body = JSON.stringify({ name: "Fed the cat", action: { type: "log", params: { label: "Fed" } } });
    const json = { ...OWNER_HEADERS, "Content-Type": "application/json", Origin: PRIVATE };
    expect((await fetch(url, { method: "POST", headers: json, body })).status).toBe(403);
    const ok = await fetch(url, { method: "POST", headers: { ...json, "X-Commons-Token": TOKEN }, body });
    expect(ok.status).toBe(201);
    const { tag } = (await ok.json()) as { tag: { id: string; public: boolean } };
    expect(tag.public).toBe(true);

    // No run route on the private API in v1: runs happen on the public gateway.
    const run = await fetch(`${url}/${tag.id}/run`, {
      method: "POST",
      headers: { ...json, "X-Commons-Token": TOKEN },
      body: "{}",
    });
    expect(run.status).toBe(404);
  });

  it("is listed in health", async () => {
    const { base } = await start({}, { appsDir: SRC_APPS });
    const health = (await (await fetch(`${base}/api/health`)).json()) as { apps: string[] };
    expect(health.apps).toContain("nfc-controls");
  });
});
