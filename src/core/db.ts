import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Schema migrations, applied in order on start. The database's
 * `PRAGMA user_version` records how many have run. Append only: never edit or
 * reorder a migration that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: per-app key-value store. Values are JSON text.
  `CREATE TABLE app_kv (
     app_id     TEXT NOT NULL,
     key        TEXT NOT NULL,
     value      TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     PRIMARY KEY (app_id, key)
   ) WITHOUT ROWID;`,
];

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/** Runs any migrations the database has not seen yet, each in a transaction. */
export function migrate(db: DatabaseSync): number {
  const current = schemaVersion(db);
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return schemaVersion(db);
}

/** Opens (creating if needed) the database at `file` and migrates it. ":memory:" works for tests. */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
