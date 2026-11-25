import { afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDatabase } from "../src/core/db";
import { discoverApps } from "../src/core/apps";
import type { SecurityConfig } from "../src/core/security";
import { createServer } from "../src/server";
import { loadConfig, PAGES_ORIGIN } from "../src/config";

export const FIXTURE_APPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "apps");
export const OWNER = "owner@example.test";
export const HOST = "node.example.ts.net:8445";
export const TOKEN = "t".repeat(64);
/** Headers tailscale serve adds for the owner on another tailnet device. */
export const OWNER_HEADERS = { "Tailscale-User-Login": OWNER, "X-Forwarded-For": "100.64.0.9" };

const open: Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

export async function start(
  security: Partial<SecurityConfig> = {},
  { appsDir = FIXTURE_APPS, env = { NODE_ENV: "test" } as NodeJS.ProcessEnv } = {},
) {
  const db = openDatabase(":memory:");
  const apps = await discoverApps(appsDir);
  const sec: SecurityConfig = {
    allowedOrigins: loadConfig(env).allowedOrigins,
    privateNetworkOrigins: [PAGES_ORIGIN],
    ownerLogin: OWNER,
    publicHost: null,
    selfIps: ["100.75.0.1"],
    csrfToken: TOKEN,
    ...security,
  };
  const listener = createServer({ db, security: sec, apps }).listen(0, "127.0.0.1");
  open.push(listener);
  await new Promise((resolve) => listener.once("listening", resolve));
  const { port } = listener.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, db, sec };
}
