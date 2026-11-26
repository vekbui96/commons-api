import express, { type Express, type RequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import { schemaVersion } from "./core/db";
import { createKv } from "./core/kv";
import { appPrefix, createEnvReader, type DiscoveredApp } from "./core/apps";
import { originGuard, requireCsrf, requireOwner, type SecurityConfig } from "./core/security";

export interface ServerDeps {
  db: DatabaseSync;
  security: SecurityConfig;
  apps: DiscoveredApp[];
  /** What apps read through ctx.env (COMMONS_* only). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the single Express app: the origin guard, the open health check, then
 * the owner-only routes (/api/session and every app router under /api/apps/<id>/).
 */
export function createServer({ db, security, apps, env = process.env }: ServerDeps): Express {
  const server = express();
  server.disable("x-powered-by");
  // Behind tailscale serve on loopback; never trust X-Forwarded-* for req.ip etc.
  server.set("trust proxy", false);
  server.use("/api", originGuard(security));

  // Open: the front end uses it to decide whether private features show.
  server.get("/api/health", (_req, res) => {
    let dbOk = true;
    let version: number | null = null;
    try {
      version = schemaVersion(db);
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      service: "commons",
      db: dbOk ? "ok" : "error",
      schemaVersion: version,
      apps: apps.map((app) => app.id),
    });
  });

  const owner: RequestHandler[] = [requireOwner(security), requireCsrf(security)];

  server.get("/api/session", ...owner, (req, res) => {
    res.set("Cache-Control", "no-store").json({
      ok: true,
      login: req.headers["tailscale-user-login"],
      csrfToken: security.csrfToken,
    });
  });

  server.use("/api/apps", ...owner, express.json({ limit: "1mb" }));
  const readEnv = createEnvReader(env);
  for (const app of apps) {
    const router = app.createRouter({ id: app.id, kv: createKv(db, app.id), db, env: readEnv });
    server.use(appPrefix(app.id), router);
  }

  server.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return server;
}
