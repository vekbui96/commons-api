// Production build: compiles src/ to plain ESM JavaScript in dist/ so the service
// runs on node directly, not under tsx. One entry for the server plus one per app
// router (src/apps/<id>/routes.ts -> dist/apps/<id>/routes.js, found by discoverApps);
// shared code goes into dist/chunks/. Packages stay external (node_modules).
import { build } from "esbuild";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "src", "apps");
const appEntries = existsSync(appsDir)
  ? readdirSync(appsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(appsDir, d.name, "routes.ts")))
      .map((d) => path.join(appsDir, d.name, "routes.ts"))
  : [];

rmSync(path.join(root, "dist"), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "src", "index.ts"), ...appEntries],
  outdir: path.join(root, "dist"),
  outbase: path.join(root, "src"),
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
console.log(
  `built dist/ (apps: ${appEntries.length ? appEntries.map((f) => path.basename(path.dirname(f))).join(", ") : "none"})`,
);
