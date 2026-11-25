import path from "node:path";
import { fileURLToPath } from "node:url";

/** This module's folder: src/ under tsx, dist/ in the compiled build. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "..");

/** The public front end on GitHub Pages (optional private features when Ve is on the tailnet). */
export const PAGES_ORIGIN = "https://vekbui96.github.io";
/** The private Commons: tailnet only via `tailscale serve` on 8445, never Funnel. The API is under /api/. */
export const PRIVATE_ORIGIN = "https://server-pc.tail0e4194.ts.net:8445";
/** Origins allowed outside production: Vite dev and preview servers on any local port. */
export const DEV_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export interface Config {
  production: boolean;
  port: number;
  host: string;
  /** SQLite file. Defaults to data/commons.db next to src/ or dist/ (gitignored). */
  dbPath: string;
  /** Allowed browser origins: exact strings or patterns. */
  allowedOrigins: (string | RegExp)[];
  /** The Host header `tailscale serve` passes on (identity routes refuse any other); null = no check. */
  publicHost: string | null;
  /** The owner's tailnet login, when set by env. Otherwise read from `tailscale status` at start. */
  ownerLogin: string | null;
  /** Where the owner identity read from tailscale is cached (data/identity.json). */
  identityCachePath: string;
  /** Folder scanned for app routers (src/apps, or dist/apps in the build). */
  appsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const allowedOrigins: (string | RegExp)[] = [PRIVATE_ORIGIN, PAGES_ORIGIN];
  if (!production) allowedOrigins.push(DEV_ORIGIN_PATTERN);
  const dbPath = path.resolve(env.COMMONS_DB_PATH ?? path.join(SERVER_ROOT, "data", "commons.db"));
  return {
    production,
    port: Number(env.COMMONS_PORT ?? 8790),
    // Loopback only: tailscale serve proxies to it. The identity headers are trusted only because of this.
    host: env.COMMONS_HOST ?? "127.0.0.1",
    dbPath,
    allowedOrigins,
    publicHost: env.COMMONS_PUBLIC_HOST?.trim() || (production ? new URL(PRIVATE_ORIGIN).host : null),
    ownerLogin: env.COMMONS_OWNER_LOGIN?.trim() || null,
    identityCachePath: path.join(path.dirname(dbPath), "identity.json"),
    appsDir: path.join(HERE, "apps"),
  };
}
