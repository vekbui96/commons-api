import { describe, expect, it } from "vitest";
import { PAGES_ORIGIN, PRIVATE_ORIGIN, loadConfig } from "../src/config";
import { parseStatus } from "../src/core/tailscale";
import { HOST, OWNER, OWNER_HEADERS, TOKEN, start } from "./helpers";

const json = { "Content-Type": "application/json" };

function write(base: string, headers: Record<string, string>, method = "PUT") {
  return fetch(`${base}/api/apps/echo/note`, { method, headers: { ...json, ...headers }, body: '{"a":1}' });
}

describe("health stays open", () => {
  it("answers with no identity, from loopback and from any allowed origin", async () => {
    const { base } = await start({ ownerLogin: null, peerCheck: async () => ({ ok: false }) });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const fromPages = await fetch(`${base}/api/health`, { headers: { Origin: PAGES_ORIGIN } });
    expect(fromPages.status).toBe(200);
    expect(fromPages.headers.get("access-control-allow-origin")).toBe(PAGES_ORIGIN);
  });
});

describe("identity", () => {
  it("requires the owner on /api/session and /api/apps/*", async () => {
    const { base } = await start();
    for (const p of ["/api/session", "/api/apps/echo/ping"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "identity_required" });
    }
  });

  it("refuses another tailnet user", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/apps/echo/ping`, {
      headers: { ...OWNER_HEADERS, "Tailscale-User-Login": "someone@else.test" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_owner" });
  });

  it("accepts the owner (login compared case-insensitively) and hands out the CSRF token", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/session`, {
      headers: { ...OWNER_HEADERS, "Tailscale-User-Login": OWNER.toUpperCase() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, login: OWNER.toUpperCase(), csrfToken: TOKEN });
  });

  it("refuses requests from server-pc itself, or not forwarded by serve", async () => {
    const { base } = await start();
    const self = await fetch(`${base}/api/session`, {
      headers: { ...OWNER_HEADERS, "X-Forwarded-For": "100.75.0.1" },
    });
    expect(self.status).toBe(403);
    expect(await self.json()).toEqual({ error: "self_request" });
    const noXff = await fetch(`${base}/api/session`, { headers: { "Tailscale-User-Login": OWNER } });
    expect(noXff.status).toBe(403);
  });

  it("refuses a request whose TCP peer is not tailscaled", async () => {
    const { base } = await start({ peerCheck: async () => ({ ok: false, why: "pid 1" }) });
    const res = await fetch(`${base}/api/session`, { headers: OWNER_HEADERS });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_via_tailscale" });
    const ok = await start({ peerCheck: async () => ({ ok: true }) });
    expect((await fetch(`${ok.base}/api/session`, { headers: OWNER_HEADERS })).status).toBe(200);
  });

  it("checks the Host when one is configured", async () => {
    const { base } = await start({ publicHost: HOST });
    // fetch sets Host to 127.0.0.1:<port>, which is not the serve name.
    const res = await fetch(`${base}/api/session`, { headers: OWNER_HEADERS });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "wrong_host" });
  });

  it("answers 503 until the owner login is known", async () => {
    const { base } = await start({ ownerLogin: null });
    expect((await fetch(`${base}/api/session`, { headers: OWNER_HEADERS })).status).toBe(503);
  });

  it("reads the owner and tailnet IPs from tailscale status, never from a tagged node", () => {
    const status = { Self: { UserID: 7, TailscaleIPs: ["100.1.2.3"] }, User: { "7": { LoginName: OWNER } } };
    expect(parseStatus(JSON.stringify(status))).toEqual({ ownerLogin: OWNER, selfIps: ["100.1.2.3"] });
    expect(parseStatus(JSON.stringify({ ...status, Self: { ...status.Self, Tags: ["tag:x"] } }))).toBeNull();
    expect(parseStatus("not json")).toBeNull();
  });
});

describe("origins", () => {
  it("rejects a present, disallowed Origin on every path", async () => {
    const { base } = await start();
    for (const p of ["/api/health", "/api/session", "/api/apps/echo/ping"]) {
      const res = await fetch(`${base}${p}`, {
        headers: { ...OWNER_HEADERS, Origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "origin_not_allowed" });
    }
  });

  it("allows the private origin and the Pages origin in production, not localhost", async () => {
    const { base } = await start({}, { env: { NODE_ENV: "production" } });
    for (const origin of [PRIVATE_ORIGIN, PAGES_ORIGIN]) {
      const res = await fetch(`${base}/api/session`, { headers: { ...OWNER_HEADERS, Origin: origin } });
      expect(res.status).toBe(200);
    }
    const local = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    expect(local.status).toBe(403);
  });

  it("answers the Pages preflight with Private Network Access", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/apps/echo/note`, {
      method: "OPTIONS",
      headers: {
        Origin: PAGES_ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type,x-commons-token",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PAGES_ORIGIN);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Commons-Token");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not grant Private Network Access to other origins, and refuses bad preflights", async () => {
    const { base } = await start();
    const pna = { "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true" };
    const same = await fetch(`${base}/api/health`, {
      method: "OPTIONS",
      headers: { ...pna, Origin: PRIVATE_ORIGIN },
    });
    expect(same.status).toBe(204);
    expect(same.headers.get("access-control-allow-private-network")).toBeNull();
    const evil = await fetch(`${base}/api/health`, {
      method: "OPTIONS",
      headers: { ...pna, Origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-private-network")).toBeNull();
  });

  it("production config names the 8445 host and has no identity cache in the repo", () => {
    const cfg = loadConfig({ NODE_ENV: "production", COMMONS_DB_PATH: "D:\\x\\data\\commons.db" });
    expect(cfg.publicHost).toBe(new URL(PRIVATE_ORIGIN).host);
    expect(cfg.ownerLogin).toBeNull();
    expect(loadConfig({ NODE_ENV: "production", COMMONS_OWNER_LOGIN: " a@b.c " }).ownerLogin).toBe("a@b.c");
  });
});

describe("CSRF on writes", () => {
  it("refuses a write without the token", async () => {
    const { base } = await start();
    const res = await write(base, { ...OWNER_HEADERS, Origin: PRIVATE_ORIGIN });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_token_invalid" });
  });

  it("refuses a write with a wrong token", async () => {
    const { base } = await start();
    const res = await write(base, {
      ...OWNER_HEADERS,
      Origin: PRIVATE_ORIGIN,
      "X-Commons-Token": "x".repeat(64),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a write without an Origin, even with the token", async () => {
    const { base } = await start();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await write(base, { ...OWNER_HEADERS, "X-Commons-Token": TOKEN }, method);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "origin_required" });
    }
  });

  it("refuses a write without identity, even with origin and token", async () => {
    const { base } = await start();
    const res = await write(base, { Origin: PRIVATE_ORIGIN, "X-Commons-Token": TOKEN });
    expect(res.status).toBe(401);
  });

  it("allows a write with identity, an allowed Origin and the token", async () => {
    const { base } = await start();
    for (const origin of [PRIVATE_ORIGIN, PAGES_ORIGIN]) {
      const res = await write(base, { ...OWNER_HEADERS, Origin: origin, "X-Commons-Token": TOKEN });
      expect(res.status).toBe(200);
    }
  });

  it("lets reads through without the token", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/apps/echo/note`, { headers: OWNER_HEADERS })).status).toBe(200);
  });
});
