import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The only browser origin allowed in production: the GitHub Pages front end. */
export const PAGES_ORIGIN = "https://vekbui96.github.io";

export interface Config {
  port: number;
  host: string;
  /** SQLite file. Defaults to server/data/commons.db (gitignored). */
  dbPath: string;
  /** Allowed CORS origins: exact strings or patterns. */
  corsOrigins: (string | RegExp)[];
  /** Folder scanned for app routers (server/src/apps). */
  appsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === "production";
  const corsOrigins: (string | RegExp)[] = [PAGES_ORIGIN];
  if (!isProduction) {
    // Vite dev and preview servers on any local port.
    corsOrigins.push(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  }
  return {
    port: Number(env.COMMONS_PORT ?? 8790),
    // Loopback only: when deployed, Tailscale Funnel proxies to it.
    host: env.COMMONS_HOST ?? "127.0.0.1",
    dbPath: path.resolve(env.COMMONS_DB_PATH ?? path.join(SERVER_ROOT, "data", "commons.db")),
    corsOrigins,
    appsDir: path.join(SERVER_ROOT, "src", "apps"),
  };
}
