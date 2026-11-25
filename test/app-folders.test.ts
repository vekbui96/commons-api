import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function appFolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

// Every app keeps its detail in its own short CLAUDE.md, never the root one.
// Template: docs/templates/app-CLAUDE.md.
describe("app folders", () => {
  for (const dir of ["src/apps", "test/fixtures/apps"]) {
    const apps = appFolders(path.join(ROOT, dir));
    it.each(apps.length ? apps : ["(none)"])(`${dir}/%s has a CLAUDE.md`, (id) => {
      if (id === "(none)") return;
      expect(existsSync(path.join(ROOT, dir, id, "CLAUDE.md"))).toBe(true);
    });
  }
});
