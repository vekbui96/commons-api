import type { DatabaseSync } from "node:sqlite";

/** A key-value store scoped to one app. Values are stored as JSON. */
export interface AppKv {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
}

export function createKv(db: DatabaseSync, appId: string): AppKv {
  const getStmt = db.prepare("SELECT value FROM app_kv WHERE app_id = ? AND key = ?");
  const setStmt = db.prepare(
    `INSERT INTO app_kv (app_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (app_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  const deleteStmt = db.prepare("DELETE FROM app_kv WHERE app_id = ? AND key = ?");
  const keysStmt = db.prepare("SELECT key FROM app_kv WHERE app_id = ? ORDER BY key");

  return {
    get<T>(key: string) {
      const row = getStmt.get(appId, key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    set(key, value) {
      setStmt.run(appId, key, JSON.stringify(value));
    },
    delete(key) {
      return Number(deleteStmt.run(appId, key).changes) > 0;
    },
    keys() {
      return (keysStmt.all(appId) as { key: string }[]).map((r) => r.key);
    },
  };
}
