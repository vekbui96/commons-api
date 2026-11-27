/**
 * SQL for the app's own tables (prefix nfc_controls_) and their append-only
 * migrations. The applied count is kept in the app's KV key `schemaVersion`;
 * core's `schemaVersion` (health) keeps meaning core schema.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AppKv } from "../../core";
import type { Action, ActionType, RunCode, TagInput } from "./model";

export const APP_MIGRATIONS: readonly string[] = [
  // 1: tags, imported public runs, edit audit.
  `CREATE TABLE nfc_controls_tags (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     enabled         INTEGER NOT NULL,
     notes           TEXT NOT NULL,
     action_type     TEXT NOT NULL,
     params          TEXT NOT NULL,
     public_key      TEXT NOT NULL,
     public_key_hash TEXT NOT NULL,
     count           INTEGER NOT NULL DEFAULT 0,
     run_count       INTEGER NOT NULL DEFAULT 0,
     revision        INTEGER NOT NULL,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   ) WITHOUT ROWID;
   CREATE TABLE nfc_controls_runs (
     id          INTEGER PRIMARY KEY,
     tag_id      TEXT NOT NULL,
     at          TEXT NOT NULL,
     via         TEXT NOT NULL,
     action_type TEXT NOT NULL,
     code        TEXT NOT NULL
   );
   CREATE INDEX nfc_controls_runs_tag ON nfc_controls_runs (tag_id, id DESC);
   CREATE TABLE nfc_controls_audit (
     id     INTEGER PRIMARY KEY,
     at     TEXT NOT NULL,
     login  TEXT NOT NULL,
     op     TEXT NOT NULL,
     tag_id TEXT,
     detail TEXT NOT NULL
   );`,
];

/** Runs every pending app migration, each in a transaction. Returns the applied count. */
export function migrateApp(db: DatabaseSync, kv: AppKv): number {
  const current = kv.get<number>("schemaVersion") ?? 0;
  for (let i = current; i < APP_MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(APP_MIGRATIONS[i]!);
      kv.set("schemaVersion", i + 1);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return kv.get<number>("schemaVersion") ?? 0;
}

export interface TagRecord extends TagInput {
  id: string;
  key: string;
  keyHash: string;
  count: number;
  runCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: number;
  tagId: string;
  at: string;
  via: "public";
  actionType: ActionType;
  code: RunCode;
}

interface TagRow {
  id: string;
  name: string;
  enabled: number;
  notes: string;
  action_type: string;
  params: string;
  public_key: string;
  public_key_hash: string;
  count: number;
  run_count: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  tag_id: string;
  at: string;
  via: string;
  action_type: string;
  code: string;
}

function toTag(r: TagRow): TagRecord {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    notes: r.notes,
    action: { type: r.action_type, params: JSON.parse(r.params) } as Action,
    key: r.public_key,
    keyHash: r.public_key_hash,
    count: r.count,
    runCount: r.run_count,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: RunRow): RunRecord {
  return {
    id: r.id,
    tagId: r.tag_id,
    at: r.at,
    via: "public",
    actionType: r.action_type as ActionType,
    code: r.code as RunCode,
  };
}

/** Retention: per tag, the newest 200 runs or everything from the last 180 days, whichever is more. */
export const KEEP_RUNS = 200;
export const KEEP_DAYS = 180;

export function createStore(db: DatabaseSync) {
  const q = {
    all: db.prepare("SELECT * FROM nfc_controls_tags ORDER BY name COLLATE NOCASE, id"),
    get: db.prepare("SELECT * FROM nfc_controls_tags WHERE id = ?"),
    exists: db.prepare("SELECT 1 AS x FROM nfc_controls_tags WHERE id = ?"),
    insert: db.prepare(
      `INSERT INTO nfc_controls_tags (id, name, enabled, notes, action_type, params, public_key, public_key_hash,
         count, run_count, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE nfc_controls_tags SET name = ?, enabled = ?, notes = ?, action_type = ?, params = ?,
         public_key = ?, public_key_hash = ?, count = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    ),
    remove: db.prepare("DELETE FROM nfc_controls_tags WHERE id = ?"),
    removeRuns: db.prepare("DELETE FROM nfc_controls_runs WHERE tag_id = ?"),
    lastRun: db.prepare("SELECT * FROM nfc_controls_runs WHERE tag_id = ? ORDER BY id DESC LIMIT 1"),
    runsForTag: db.prepare(
      "SELECT * FROM nfc_controls_runs WHERE tag_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
    ),
    runsAll: db.prepare("SELECT * FROM nfc_controls_runs WHERE id < ? ORDER BY id DESC LIMIT ?"),
    addRun: db.prepare(
      "INSERT INTO nfc_controls_runs (tag_id, at, via, action_type, code) VALUES (?, ?, ?, ?, ?)",
    ),
    bump: db.prepare(
      "UPDATE nfc_controls_tags SET run_count = run_count + 1, count = count + ? WHERE id = ?",
    ),
    prune: db.prepare(
      `DELETE FROM nfc_controls_runs WHERE tag_id = ? AND at < ? AND id NOT IN
         (SELECT id FROM nfc_controls_runs WHERE tag_id = ? ORDER BY id DESC LIMIT ${KEEP_RUNS})`,
    ),
    audit: db.prepare(
      "INSERT INTO nfc_controls_audit (at, login, op, tag_id, detail) VALUES (?, ?, ?, ?, ?)",
    ),
  };

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  return {
    transaction,
    list: () => (q.all.all() as unknown as TagRow[]).map(toTag),
    get: (id: string) => {
      const row = q.get.get(id) as unknown as TagRow | undefined;
      return row ? toTag(row) : undefined;
    },
    exists: (id: string) => q.exists.get(id) !== undefined,
    insert(id: string, input: TagInput, key: string, hash: string, at: string) {
      q.insert.run(
        id,
        input.name,
        input.enabled ? 1 : 0,
        input.notes,
        input.action.type,
        JSON.stringify(input.action.params),
        key,
        hash,
        at,
        at,
      );
    },
    /** Replaces config (and optionally key/count); bumps revision. */
    update(tag: TagRecord, at: string) {
      q.update.run(
        tag.name,
        tag.enabled ? 1 : 0,
        tag.notes,
        tag.action.type,
        JSON.stringify(tag.action.params),
        tag.key,
        tag.keyHash,
        tag.count,
        at,
        tag.id,
      );
    },
    remove(id: string) {
      transaction(() => {
        q.removeRuns.run(id);
        q.remove.run(id);
      });
    },
    lastRun(id: string) {
      const row = q.lastRun.get(id) as unknown as RunRow | undefined;
      return row ? toRun(row) : null;
    },
    runs(tagId: string | null, before: number, limit: number) {
      const rows = (tagId === null
        ? q.runsAll.all(before, limit)
        : q.runsForTag.all(tagId, before, limit)) as unknown as RunRow[];
      return rows.map(toRun);
    },
    /** Records one imported run and its counters. Call inside a transaction. */
    addRun(tagId: string, at: string, actionType: ActionType, code: RunCode, counts: boolean) {
      q.addRun.run(tagId, at, "public", actionType, code);
      q.bump.run(counts ? 1 : 0, tagId);
    },
    prune(tagId: string, now: Date) {
      const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString();
      q.prune.run(tagId, cutoff, tagId);
    },
    audit(at: string, login: string, op: string, tagId: string | null, detail: string[]) {
      q.audit.run(at, login, op, tagId, detail.join(","));
    },
  };
}

export type Store = ReturnType<typeof createStore>;
