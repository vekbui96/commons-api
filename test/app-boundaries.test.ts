import { describe, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import rule from "../eslint/app-boundaries.js";

// Wire ESLint's RuleTester into Vitest.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (...parts: string[]) => path.join(ROOT, ...parts);

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" },
});

tester.run("commons/app-boundaries", rule, {
  valid: [
    { filename: file("src/apps/alpha/routes.ts"), code: 'import { defineAppRouter } from "../../core";' },
    {
      filename: file("src/apps/alpha/routes.ts"),
      code: 'import { defineAppRouter } from "../../core/index";',
    },
    { filename: file("src/apps/alpha/routes.ts"), code: 'import { helper } from "./lib/helper";' },
    { filename: file("src/apps/alpha/lib/helper.ts"), code: 'import type { Thing } from "../types";' },
    { filename: file("src/apps/alpha/routes.ts"), code: 'import { Router } from "express";' },
    // The core's auto-discovery: a dynamic import of a computed path.
    { filename: file("src/core/apps.ts"), code: "const mod = await import(url);" },
    { filename: file("src/server.ts"), code: 'import { createKv } from "./core/kv";' },
  ],
  invalid: [
    {
      filename: file("src/apps/alpha/routes.ts"),
      code: 'import { thing } from "../beta/lib";',
      errors: [{ messageId: "crossApp" }],
    },
    {
      filename: file("src/apps/alpha/routes.ts"),
      code: 'export * from "../beta/routes";',
      errors: [{ messageId: "crossApp" }],
    },
    {
      filename: file("src/apps/alpha/routes.ts"),
      code: 'const m = await import("../beta/routes");',
      errors: [{ messageId: "crossApp" }],
    },
    {
      filename: file("src/core/apps.ts"),
      code: 'import alpha from "../apps/alpha/routes";',
      errors: [{ messageId: "intoApp" }],
    },
    {
      filename: file("src/server.ts"),
      code: 'import type { X } from "./apps/alpha/types";',
      errors: [{ messageId: "intoApp" }],
    },
    {
      filename: file("src/apps/alpha/routes.ts"),
      code: 'import { openDatabase } from "../../core/db";',
      errors: [{ messageId: "appOutside" }],
    },
    {
      filename: file("src/apps/alpha/routes.ts"),
      code: 'import { loadConfig } from "../../config";',
      errors: [{ messageId: "appOutside" }],
    },
  ],
});
