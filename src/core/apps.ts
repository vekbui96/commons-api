import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { AppKv } from "./kv";

/**
 * What the core hands each app's router factory. Apps never open their own
 * database, port or server: they get these shared pieces from the one entry
 * point. (Auth will be added here later.)
 */
export interface AppContext {
  /** The app's id, equal to its folder name and to its web app id when paired. */
  id: string;
  /** Key-value storage scoped to this app. */
  kv: AppKv;
  /** The shared database, for apps that outgrow the KV store. Prefix any tables with the app id. */
  db: DatabaseSync;
  /**
   * Reads a `COMMONS_*` environment variable (trimmed; empty or unset is
   * undefined), so apps get their config without importing src/config.ts.
   * Read at call time. Any other name throws: apps never read arbitrary env.
   */
  env(name: string): string | undefined;
}

const ENV_NAME = /^COMMONS_[A-Z0-9_]+$/;

/** The `env` accessor apps get in their context, over a given environment. */
export function createEnvReader(source: NodeJS.ProcessEnv = process.env): AppContext["env"] {
  return (name) => {
    if (!ENV_NAME.test(name)) throw new Error(`apps may only read COMMONS_* variables (asked for ${name})`);
    const value = source[name]?.trim();
    return value ? value : undefined;
  };
}

/** An app's server module (server/src/apps/<id>/routes.ts) default-exports one of these. */
export type AppRouterFactory = (ctx: AppContext) => Router;

/** Identity helper so app routers are type-checked where they are written. */
export function defineAppRouter(factory: AppRouterFactory): AppRouterFactory {
  return factory;
}

export interface DiscoveredApp {
  id: string;
  createRouter: AppRouterFactory;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Finds every `<appsDir>/<id>/routes.ts` (or `routes.js` in the compiled build)
 * and imports its router factory.
 */
export async function discoverApps(appsDir: string): Promise<DiscoveredApp[]> {
  if (!existsSync(appsDir)) return [];
  const apps: DiscoveredApp[] = [];
  const folders = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const id of folders) {
    const file = ["routes.ts", "routes.js"]
      .map((name) => path.join(appsDir, id, name))
      .find((candidate) => existsSync(candidate));
    if (!file) continue;
    if (!ID_PATTERN.test(id)) {
      throw new Error(`server app folder "${id}" must be kebab-case`);
    }
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      throw new Error(`apps/${id}/routes must default-export a router factory`);
    }
    apps.push({ id, createRouter: mod.default as AppRouterFactory });
  }
  return apps;
}

/** The URL prefix an app's router is mounted under. */
export function appPrefix(id: string): string {
  return `/api/apps/${id}`;
}
