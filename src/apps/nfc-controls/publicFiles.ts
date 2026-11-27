/**
 * The public side's inputs and outputs (contract: "Hand-off files", "Static backup copy").
 * - snapshot: public-tags.json for the gateway (public projection + key hash only);
 * - backup: tags.json for GitHub Pages, every entry encrypted with a key derived from the link;
 * - importer: reads the gateway's public.db read-only, as untrusted input.
 */
import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ACTION_TYPES,
  CODES_FOR,
  isTagId,
  RUN_CODES,
  type Action,
  type ActionType,
  type RunCode,
} from "./model";
import type { TagRecord } from "./store";

/** The public projection of an action: exactly the params the contract lists. */
export function publicAction(action: Action): Action {
  switch (action.type) {
    case "open_url":
      return { type: "open_url", params: { url: action.params.url, label: action.params.label } };
    case "log":
      return { type: "log", params: { label: action.params.label } };
    case "note":
      return {
        type: "note",
        params: { title: action.params.title, text: action.params.text, items: [...action.params.items] },
      };
  }
}

export function snapshotText(tags: TagRecord[], generatedAt: string): string {
  const entries = tags
    .filter((t) => t.enabled)
    .map((t) => ({ id: t.id, name: t.name, keyHash: t.keyHash, action: publicAction(t.action) }));
  return `${JSON.stringify({ version: 1, generatedAt, tags: entries }, null, 2)}\n`;
}

/** Temp file, then rename (retried: the gateway may be reading the old file at that moment). */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

const sha256 = (...parts: (string | Buffer)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** One backup entry for a tag (contract: "Static backup copy"). */
export function backupEntry(tag: Pick<TagRecord, "id" | "key" | "name" | "action">) {
  const material = `${tag.id}\n${tag.key}`;
  const lookup = sha256(`commons-nfc-backup/v1/lookup\n${material}`).toString("hex");
  const aesKey = sha256(`commons-nfc-backup/v1/key\n${material}`);
  const plain = JSON.stringify({ id: tag.id, name: tag.name, action: publicAction(tag.action) });
  const iv = sha256(aesKey, plain).subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { lookup, iv: iv.toString("base64url"), data: data.toString("base64url") };
}

export function inBackup(tag: Pick<TagRecord, "enabled" | "action">): boolean {
  return tag.enabled && (tag.action.type === "open_url" || tag.action.type === "note");
}

export function backupText(tags: TagRecord[]): { text: string; count: number } {
  const entries = tags
    .filter(inBackup)
    .map(backupEntry)
    .sort((a, b) => (a.lookup < b.lookup ? -1 : 1));
  const map: Record<string, { iv: string; data: string }> = {};
  for (const e of entries) map[e.lookup] = { iv: e.iv, data: e.data };
  return { text: `${JSON.stringify({ version: 1, tags: map }, null, 2)}\n`, count: entries.length };
}

export interface ImportedRun {
  sourceId: number;
  tagId: string;
  at: string;
  actionType: ActionType;
  code: RunCode;
}

export interface ImportBatch {
  instance: string;
  runs: ImportedRun[];
  /** The highest source id seen (valid or not): the next cursor. */
  lastId: number;
  skipped: number;
  more: boolean;
}

const INSTANCE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_AHEAD_MS = 5 * 60000;
const MAX_AGE_MS = 400 * 86400000;

/**
 * Reads up to `limit` runs after `cursor` from the gateway's database, read-only. Every
 * field is untrusted: rows that fail a check are skipped (but the cursor still passes them).
 * Returns null when the file does not exist (no public taps yet).
 */
export function readPublicRuns(
  file: string,
  cursor: { instance: string | null; lastId: number },
  now: Date,
  limit = 1000,
): ImportBatch | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'instance'").get() as
      { value?: unknown } | undefined;
    const instance = typeof meta?.value === "string" && INSTANCE.test(meta.value) ? meta.value : null;
    if (!instance) throw new Error("public.db has no valid instance id");
    const after = instance === cursor.instance ? cursor.lastId : 0;
    const rows = db
      .prepare("SELECT id, at, tag_id, action_type, code FROM public_runs WHERE id > ? ORDER BY id LIMIT ?")
      .all(after, limit) as Record<string, unknown>[];
    const runs: ImportedRun[] = [];
    let lastId = after;
    let skipped = 0;
    for (const row of rows) {
      const id = row.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= lastId) {
        skipped++;
        continue;
      }
      lastId = id;
      const { at, tag_id: tagId, action_type: type, code } = row;
      const time = typeof at === "string" && at.length <= 40 ? Date.parse(at) : NaN;
      const valid =
        Number.isFinite(time) &&
        time <= now.getTime() + MAX_AHEAD_MS &&
        time >= now.getTime() - MAX_AGE_MS &&
        isTagId(tagId) &&
        typeof type === "string" &&
        (ACTION_TYPES as readonly string[]).includes(type) &&
        typeof code === "string" &&
        (RUN_CODES as readonly string[]).includes(code) &&
        CODES_FOR[type as ActionType].includes(code as RunCode);
      if (!valid) {
        skipped++;
        continue;
      }
      runs.push({
        sourceId: id,
        tagId: tagId as string,
        at: new Date(time).toISOString(),
        actionType: type as ActionType,
        code: code as RunCode,
      });
    }
    return { instance, runs, lastId, skipped, more: rows.length === limit };
  } finally {
    db.close();
  }
}
