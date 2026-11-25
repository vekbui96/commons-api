/**
 * The one entry point for the Commons backend: one process, one port. Apps
 * never get their own server; they plug in as routers under
 * src/apps/<id>/routes.ts and are mounted at /api/apps/<id>/.
 */
import { loadConfig, PAGES_ORIGIN } from "./config";
import { openDatabase } from "./core/db";
import { discoverApps } from "./core/apps";
import { newCsrfToken, type SecurityConfig } from "./core/security";
import {
  makePeerCheck,
  readIdentityCache,
  readTailscaleIdentity,
  writeIdentityCache,
} from "./core/tailscale";
import { createServer } from "./server";

const config = loadConfig();
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const db = openDatabase(config.dbPath);
const apps = await discoverApps(config.appsDir);

const security: SecurityConfig = {
  allowedOrigins: config.allowedOrigins,
  privateNetworkOrigins: [PAGES_ORIGIN],
  ownerLogin: config.ownerLogin,
  publicHost: config.publicHost,
  selfIps: [],
  csrfToken: newCsrfToken(),
};

if (config.production) {
  if (process.platform === "win32") security.peerCheck = makePeerCheck(config.port, log);
  else log("warning: no peer check off Windows; identity headers are trusted from any loopback client");
  // Owner login and this node's tailnet IPs: COMMONS_OWNER_LOGIN wins for the login; tailscale status
  // fills the rest (retried until it answers), with the last answer cached next to the database.
  const cached = readIdentityCache(config.identityCachePath);
  if (cached) {
    security.ownerLogin ??= cached.ownerLogin;
    security.selfIps = cached.selfIps;
  }
  const loadIdentity = async () => {
    const id = await readTailscaleIdentity();
    if (!id) {
      log("tailscale status did not answer; retrying in 15 s");
      setTimeout(loadIdentity, 15000).unref();
      return;
    }
    security.ownerLogin = config.ownerLogin ?? id.ownerLogin;
    security.selfIps = id.selfIps;
    writeIdentityCache(config.identityCachePath, id);
    log(`identity loaded (${id.selfIps.length} tailnet IPs)`);
  };
  void loadIdentity();
}

const server = createServer({ db, security, apps });
const listener = server.listen(config.port, config.host, () => {
  const mounted = apps.length ? apps.map((a) => a.id).join(", ") : "none";
  log(
    `commons server on http://${config.host}:${config.port} (${config.production ? "production" : "development"}; db ${config.dbPath}; apps: ${mounted})`,
  );
});

function shutdown() {
  listener.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
