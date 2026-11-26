import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvReader } from "../src/core/apps";
import { OWNER_HEADERS, start, TOKEN } from "./helpers";

// The real src/apps, mounted through discovery (core security in front), as in production.
const SRC_APPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "apps");

describe("profiles behind core security", () => {
  it("is owner only, and writes need Origin + CSRF", async () => {
    const { base } = await start({}, { appsDir: SRC_APPS });
    const url = `${base}/api/apps/profiles/profiles`;
    expect((await fetch(url)).status).toBe(401);
    const other = await fetch(url, {
      headers: { ...OWNER_HEADERS, "Tailscale-User-Login": "x@example.test" },
    });
    expect(other.status).toBe(403);
    const res = await fetch(url, { headers: OWNER_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, revision: 1, dirty: false });

    const body = JSON.stringify({ name: "Ann", apps: [] });
    const json = { ...OWNER_HEADERS, "Content-Type": "application/json" };
    const noToken = await fetch(`${url}/ann`, {
      method: "PUT",
      headers: { ...json, Origin: "https://vekbui96.github.io" },
      body,
    });
    expect(noToken.status).toBe(403);
    const ok = await fetch(`${url}/ann`, {
      method: "PUT",
      headers: { ...json, Origin: "https://vekbui96.github.io", "X-Commons-Token": TOKEN },
      body,
    });
    expect(ok.status).toBe(201);
  });

  it("answers publish_not_configured without a token", async () => {
    const saved = process.env.COMMONS_PROFILES_TOKEN;
    delete process.env.COMMONS_PROFILES_TOKEN;
    try {
      const { base } = await start({}, { appsDir: SRC_APPS });
      const res = await fetch(`${base}/api/apps/profiles/publish`, {
        method: "POST",
        headers: { ...OWNER_HEADERS, Origin: "https://vekbui96.github.io", "X-Commons-Token": TOKEN },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "publish_not_configured" });
    } finally {
      if (saved !== undefined) process.env.COMMONS_PROFILES_TOKEN = saved;
    }
  });
});

describe("ctx.env", () => {
  it("reads COMMONS_* only, trimmed, empty as undefined", () => {
    const env = createEnvReader({ COMMONS_A: " x ", COMMONS_EMPTY: "  ", PATH: "p" });
    expect(env("COMMONS_A")).toBe("x");
    expect(env("COMMONS_EMPTY")).toBeUndefined();
    expect(env("COMMONS_MISSING")).toBeUndefined();
    expect(() => env("PATH")).toThrow(/COMMONS_/);
  });
});
