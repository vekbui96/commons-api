// @ts-check
/**
 * Local ESLint rule: the wall between apps.
 *
 * - Code in src/apps/<a>/ may import only its own folder, the core's public
 *   interface (src/core/index.ts) and packages. Never src/apps/<b>/, never
 *   other core modules, never src/server.ts, src/config.ts or test/.
 * - Nothing outside src/apps/<a>/ (core included) may import from it. The core
 *   mounts apps through discoverApps(), a dynamic import of a computed path,
 *   which this rule does not see and so stays allowed.
 *
 * Only relative specifiers can reach repo files, so bare package names pass.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = path.join(ROOT, "src", "apps");
const CORE_DIR = path.join(ROOT, "src", "core");
const CORE_PUBLIC = path.join(CORE_DIR, "index");

/** @param {string} file @returns {string | null} the app id when file is inside src/apps/<id>/ */
function appOf(file) {
  const rel = path.relative(APPS_DIR, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [id, ...rest] = rel.split(path.sep);
  return rest.length ? id : null;
}

/** Strip a source extension so "../../core/index.ts" and "../../core/index" compare equal. @param {string} file */
function stripExt(file) {
  return file.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, "");
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Keep Commons apps from importing each other or being imported by core." },
    schema: [],
    messages: {
      crossApp:
        'App "{{from}}" must not import from app "{{to}}". Apps share nothing but src/core; reuse a finished app through its published API or embed.',
      intoApp:
        'Only app "{{to}}" may import its own code. Core and other modules reach apps through discoverApps(), never a direct import.',
      appOutside:
        'App "{{from}}" may import only its own folder and src/core\'s public interface ("src/core/index.ts").',
    },
  },
  create(context) {
    const filename = path.resolve(context.filename);
    const fromApp = appOf(filename);

    /** @param {import("estree").Node | null | undefined} source */
    function check(source) {
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      const spec = source.value;
      if (!spec.startsWith(".")) return;
      const target = path.resolve(path.dirname(filename), spec);
      const toApp = appOf(target) ?? (path.resolve(target) === APPS_DIR ? "" : null);

      if (fromApp) {
        if (toApp === fromApp) return;
        if (toApp !== null) {
          context.report({ node: source, messageId: "crossApp", data: { from: fromApp, to: toApp || "*" } });
          return;
        }
        const t = stripExt(target);
        if (t === CORE_PUBLIC || t === CORE_DIR) return;
        context.report({ node: source, messageId: "appOutside", data: { from: fromApp } });
        return;
      }
      if (toApp !== null) {
        context.report({ node: source, messageId: "intoApp", data: { to: toApp || "*" } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          const arg = node.arguments[0];
          if (arg && arg.type !== "SpreadElement") check(arg);
        }
      },
    };
  },
};

export default rule;
