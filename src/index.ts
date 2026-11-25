/**
 * The one entry point for the Commons backend: one process, one port. Apps
 * never get their own server; they plug in as routers under
 * server/src/apps/<id>/routes.ts and are mounted at /api/apps/<id>/.
 */
import { loadConfig } from "./config";
import { openDatabase } from "./core/db";
import { discoverApps } from "./core/apps";
import { createServer } from "./server";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const apps = await discoverApps(config.appsDir);
const server = createServer({ db, corsOrigins: config.corsOrigins, apps });

const listener = server.listen(config.port, config.host, () => {
  const mounted = apps.length ? apps.map((a) => a.id).join(", ") : "none";
  console.log(
    `commons server on http://${config.host}:${config.port} (db ${config.dbPath}; apps: ${mounted})`,
  );
});

function shutdown() {
  listener.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
