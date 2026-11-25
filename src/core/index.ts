/**
 * The core's public interface for apps. Code in src/apps/<id>/ imports from
 * here (`../../core`) and nowhere else in core; the lint rule
 * `commons/app-boundaries` enforces it. Everything an app needs at runtime
 * arrives in `ctx` (see AppContext).
 */
export { defineAppRouter } from "./apps";
export type { AppContext, AppRouterFactory } from "./apps";
export type { AppKv } from "./kv";
