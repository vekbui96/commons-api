import { Router, type Response } from "express";
import { readFileSync, statSync } from "node:fs";
import { defineAppRouter } from "../../core";

/** Where the ops hub writes the map. Override with COMMONS_ARCH_PATH (non-secret config). */
export const DEFAULT_ARCH_PATH = "D:\\hub\\state\\architecture.json";
/** Bigger than this is not a map the hub would write: refuse it. */
export const MAX_BYTES = 1024 * 1024;

type Result = { ok: true; body: string } | { ok: false; status: 502 | 503; error: string };

interface Cached {
  path: string;
  mtimeMs: number;
  size: number;
  result: Result;
}

const NOT_READY: Result = { ok: false, status: 503, error: "map_not_ready" };
const INVALID: Result = { ok: false, status: 502, error: "map_invalid" };

/** Top-level check only (schema v1): `schema === 1`, `nodes` and `edges` arrays. */
export function validMap(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const map = value as Record<string, unknown>;
  return map.schema === 1 && Array.isArray(map.nodes) && Array.isArray(map.edges);
}

/**
 * Reads the map file read-only, cached by path + mtime + size. Errors carry only a
 * code: never a path or a file system message.
 */
export function createMapReader(getPath: () => string) {
  let cache: Cached | null = null;
  return function read(): Result {
    const file = getPath();
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return NOT_READY; // missing (or unreachable): the hub has not written it yet
    }
    if (!stat.isFile()) return INVALID;
    if (stat.size > MAX_BYTES) return INVALID;
    if (cache && cache.path === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.result;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return NOT_READY; // e.g. locked mid-write; try again next request
    }
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return INVALID;
    let result: Result;
    try {
      result = validMap(JSON.parse(text.replace(/^\uFEFF/, ""))) ? { ok: true, body: text } : INVALID;
    } catch {
      result = INVALID;
    }
    cache = { path: file, mtimeMs: stat.mtimeMs, size: stat.size, result };
    return result;
  };
}

function send(res: Response, result: Result) {
  res.set("Cache-Control", "no-store");
  if (result.ok) {
    res.type("application/json").send(result.body);
  } else {
    res.status(result.status).json({ ok: false, error: result.error });
  }
}

export function createServerMapRouter(getPath: () => string): Router {
  const read = createMapReader(getPath);
  const router = Router();
  router.get("/architecture", (_req, res) => send(res, read()));
  return router;
}

// The env var is read per request so a service restart is not the only way to repoint it in dev.
export default defineAppRouter(() =>
  createServerMapRouter(() => process.env.COMMONS_ARCH_PATH?.trim() || DEFAULT_ARCH_PATH),
);
