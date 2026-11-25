// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import appBoundaries from "./eslint/app-boundaries.js";

export default tseslint.config(
  {
    ignores: ["dist", "coverage", "node_modules", "data", ".claude/worktrees"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },
  {
    // The wall between apps: see eslint/app-boundaries.js and CLAUDE.md.
    plugins: { commons: { rules: { "app-boundaries": appBoundaries } } },
    rules: { "commons/app-boundaries": "error" },
  },
);
