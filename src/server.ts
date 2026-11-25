import cors from "cors";
import express, { type Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { schemaVersion } from "./core/db";
import { createKv } from "./core/kv";
import { appPrefix, type DiscoveredApp } from "./core/apps";

export interface ServerDeps {
  db: DatabaseSync;
  corsOrigins: (string | RegExp)[];
  apps: DiscoveredApp[];
}

/**
 * Builds the single Express app: core routes first, then every discovered app
 * router mounted under /api/apps/<id>/.
 */
export function createServer({ db, corsOrigins, apps }: ServerDeps): Express {
  const server = express();
  server.disable("x-powered-by");
  server.use(cors({ origin: corsOrigins }));
  server.use(express.json({ limit: "1mb" }));

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

  for (const app of apps) {
    const router = app.createRouter({ id: app.id, kv: createKv(db, app.id), db });
    server.use(appPrefix(app.id), router);
  }

  server.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return server;
}
