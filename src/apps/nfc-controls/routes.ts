import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { defineAppRouter, pagesUrl, PublishError, putFile, REPO_PATTERN, type AppKv } from "../../core";
import { isTagId, keyHash, newKey, newTagId, parseTagBody, RUN_MESSAGES, type TagInput } from "./model";
import { backupText, inBackup, readPublicRuns, snapshotText, writeAtomic } from "./publicFiles";
import { createStore, migrateApp, type RunRecord, type TagRecord } from "./store";

export const DEFAULT_LINK_BASE = "https://vekbui96.github.io/commons/#/t/";
export const DEFAULT_BACKUP_REPO = "vekbui96/commons-nfc-tags";
export const BACKUP_PATH = "tags.json";
export const BACKUP_BRANCH = "main";
const IMPORT_EVERY_MS = 5000;
const BACKGROUND_IMPORT_MS = 10 * 60000;
const BACKUP_DEBOUNCE_MS = 3000;

export interface NfcDeps {
  db: DatabaseSync;
  kv: AppKv;
  env: (name: string) => string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Runs `fn` later (debounced backup publish). Tests pass a manual scheduler. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Background import every 10 minutes (off in tests). */
  background?: boolean;
}

interface ImportState {
  instance: string | null;
  lastId: number;
  importedAt: string | null;
  error: string | null;
}

interface BackupRecord {
  hash: string | null;
  tags: number;
  publishedAt: string | null;
  commitSha: string | null;
  lastAttemptAt: string | null;
  lastError: { error: string; status?: number; at: string } | null;
}

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ ok: false, error, ...extra });
}

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

export function createNfcRouter({
  db,
  kv,
  env,
  fetch: fetchFn = fetch,
  now = () => new Date(),
  log = (msg) => console.log(`${new Date().toISOString()} nfc-controls: ${msg}`),
  schedule = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
  background = false,
}: NfcDeps): Router {
  migrateApp(db, kv);
  const store = createStore(db);
  const stamp = () => now().toISOString();

  const linkBase = () => {
    const base = env("COMMONS_NFC_PUBLIC_LINK_BASE") ?? DEFAULT_LINK_BASE;
    return base.startsWith("https://") ? base : DEFAULT_LINK_BASE;
  };
  const runView = (r: RunRecord) => ({
    id: r.id,
    tagId: r.tagId,
    at: r.at,
    via: r.via,
    actionType: r.actionType,
    ok: true,
    code: r.code,
    message: RUN_MESSAGES[r.code],
  });
  const tagView = (t: TagRecord, full: boolean) => {
    const last = store.lastRun(t.id);
    return {
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      ...(full ? { notes: t.notes } : {}),
      action: t.action,
      public: true,
      publicLink: `${linkBase()}${t.id}?k=${t.key}`,
      inBackup: inBackup(t),
      revision: t.revision,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      count: t.action.type === "log" ? t.count : 0,
      runCount: t.runCount,
      lastRun: last ? runView(last) : null,
    };
  };

  // ------------------------------------------------------------ snapshot (private -> public)
  const snapshot = { writtenAt: null as string | null, tags: 0, error: null as string | null };
  const writeSnapshot = () => {
    const file = env("COMMONS_NFC_SNAPSHOT_PATH");
    if (!file) return;
    const at = stamp();
    try {
      const tags = store.list();
      writeAtomic(file, snapshotText(tags, at));
      Object.assign(snapshot, { writtenAt: at, tags: tags.filter((t) => t.enabled).length, error: null });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "write_failed";
      snapshot.error = `snapshot_write_failed:${code}`;
      log(`snapshot write failed (${code})`);
    }
  };

  // ------------------------------------------------------------ public runs (public -> private, untrusted)
  const importState = (): ImportState =>
    kv.get<ImportState>("import") ?? { instance: null, lastId: 0, importedAt: null, error: null };
  let lastImportAt = 0;
  const importRuns = (force = false) => {
    const file = env("COMMONS_NFC_PUBLIC_DB");
    if (!file) return;
    const t = now().getTime();
    if (!force && t - lastImportAt < IMPORT_EVERY_MS) return;
    lastImportAt = t;
    let state = importState();
    try {
      for (let pass = 0; pass < 10; pass++) {
        const batch = readPublicRuns(file, state, now());
        if (!batch) break;
        const touched = new Set<string>();
        store.transaction(() => {
          for (const run of batch.runs) {
            const tag = store.get(run.tagId);
            if (!tag) continue;
            store.addRun(
              run.tagId,
              run.at,
              run.actionType,
              run.code,
              run.code === "counted" && tag.action.type === "log",
            );
            touched.add(run.tagId);
          }
          for (const id of touched) store.prune(id, now());
          state = { ...state, instance: batch.instance, lastId: batch.lastId };
          kv.set("import", state);
        });
        if (batch.skipped) log(`skipped ${batch.skipped} malformed public run(s)`);
        if (!batch.more) break;
      }
      state = { ...state, importedAt: stamp(), error: null };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "read_failed";
      state = { ...state, error: `import_failed:${code}` };
      log(`public run import failed (${code})`);
    }
    kv.set("import", state);
  };

  // ------------------------------------------------------------ backup copy on GitHub
  const backupTarget = () => {
    const repo = env("COMMONS_NFC_BACKUP_REPO") ?? DEFAULT_BACKUP_REPO;
    return REPO_PATTERN.test(repo) ? { repo, token: env("COMMONS_NFC_BACKUP_TOKEN") } : null;
  };
  const backupRecord = (): BackupRecord =>
    kv.get<BackupRecord>("backup") ?? {
      hash: null,
      tags: 0,
      publishedAt: null,
      commitSha: null,
      lastAttemptAt: null,
      lastError: null,
    };
  const backupStatus = () => {
    const t = backupTarget();
    const r = backupRecord();
    const current = backupText(store.list());
    return {
      configured: Boolean(t?.token),
      repo: t?.repo ?? null,
      url: t ? pagesUrl(t.repo, BACKUP_PATH) : null,
      dirty: hashText(current.text) !== r.hash,
      tags: current.count,
      publishedAt: r.publishedAt,
      commitSha: r.commitSha,
      lastAttemptAt: r.lastAttemptAt,
      lastError: r.lastError,
    };
  };

  let publishing = false;
  const publishBackup = async (): Promise<{
    status: number;
    error?: string;
    extra?: Record<string, unknown>;
  }> => {
    const t = backupTarget();
    if (!t?.token) return { status: 503, error: "backup_not_configured" };
    if (publishing) return { status: 409, error: "backup_in_progress" };
    publishing = true;
    const at = stamp();
    const { text, count } = backupText(store.list());
    try {
      const result = await putFile(
        fetchFn,
        { repo: t.repo, path: BACKUP_PATH, branch: BACKUP_BRANCH, token: t.token },
        text,
        `Publish NFC backup copy (${count} tag${count === 1 ? "" : "s"}) from Commons`,
      );
      const before = backupRecord();
      kv.set("backup", {
        hash: hashText(text),
        tags: count,
        publishedAt: at,
        commitSha: result.unchanged ? before.commitSha : result.commitSha,
        lastAttemptAt: at,
        lastError: null,
      } satisfies BackupRecord);
      log(`backup published (${count} tags${result.unchanged ? ", unchanged" : ""})`);
      return { status: 200 };
    } catch (err) {
      const code = err instanceof PublishError ? err.code : "github_error";
      const status = err instanceof PublishError ? err.status : undefined;
      kv.set("backup", {
        ...backupRecord(),
        lastAttemptAt: at,
        lastError: { error: code, ...(status ? { status } : {}), at },
      } satisfies BackupRecord);
      log(`backup publish failed: ${code}${status ? ` (${status})` : ""}`);
      return { status: 502, error: "backup_failed", extra: { reason: code, ...(status ? { status } : {}) } };
    } finally {
      publishing = false;
    }
  };

  let cancelPending: (() => void) | null = null;
  const scheduleBackup = () => {
    if (!backupTarget()?.token) return;
    cancelPending?.();
    cancelPending = schedule(() => {
      cancelPending = null;
      if (publishing) return scheduleBackup();
      if (backupStatus().dirty) void publishBackup();
    }, BACKUP_DEBOUNCE_MS);
  };

  const afterChange = () => {
    writeSnapshot();
    scheduleBackup();
  };

  writeSnapshot();
  scheduleBackup();
  if (background) setInterval(() => importRuns(true), BACKGROUND_IMPORT_MS).unref();

  // ------------------------------------------------------------ routes
  const login = (req: Request) => req.get("tailscale-user-login") ?? "unknown";
  const findTag = (req: Request, res: Response): TagRecord | undefined => {
    const id = req.params.id;
    const tag = isTagId(id) ? store.get(id) : undefined;
    if (!tag) fail(res, 404, "tag_not_found");
    return tag;
  };
  const parsePage = (req: Request, res: Response, fallback: number) => {
    const { limit, before } = req.query;
    const int = (v: unknown) => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
    const l = limit === undefined ? fallback : int(limit);
    const b = before === undefined ? Number.MAX_SAFE_INTEGER : int(before);
    if (!(l >= 1 && l <= 200) || !(b >= 1)) {
      fail(res, 400, "invalid_query", { problems: ["limit must be 1-200 and before a run id"] });
      return null;
    }
    return { limit: l, before: b };
  };
  const page = (runs: RunRecord[], limit: number) => ({
    ok: true,
    runs: runs.map(runView),
    nextBefore: runs.length === limit ? runs[runs.length - 1]!.id : null,
  });
  const changed = (a: TagRecord, b: TagInput) =>
    (
      [
        ["name", a.name !== b.name],
        ["enabled", a.enabled !== b.enabled],
        ["notes", a.notes !== b.notes],
        ["action.type", a.action.type !== b.action.type],
        ["action.params", JSON.stringify(a.action.params) !== JSON.stringify(b.action.params)],
      ] as const
    )
      .filter(([, c]) => c)
      .map(([n]) => n);

  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/tags", (_req, res) => {
    importRuns();
    res.json({ ok: true, tags: store.list().map((t) => tagView(t, false)) });
  });

  router.get("/tags/:id", (req, res) => {
    importRuns();
    const tag = findTag(req, res);
    if (tag) res.json({ ok: true, tag: tagView(tag, true) });
  });

  router.post("/tags", (req, res) => {
    const parsed = parseTagBody(req.body, { create: true });
    if (!parsed.ok) return fail(res, 400, parsed.error, { problems: parsed.problems });
    let id = parsed.id;
    if (id && store.exists(id)) return fail(res, 409, "tag_exists");
    while (!id || store.exists(id)) id = newTagId();
    const key = newKey();
    const at = stamp();
    store.transaction(() => {
      store.insert(id, parsed.value, key, keyHash(key), at);
      store.audit(at, login(req), "create", id, ["name", "enabled", "notes", "action.type", "action.params"]);
    });
    afterChange();
    res.status(201).json({ ok: true, tag: tagView(store.get(id)!, true) });
  });

  router.put("/tags/:id", (req, res) => {
    const tag = findTag(req, res);
    if (!tag) return;
    const parsed = parseTagBody(req.body, { create: false, urlId: tag.id });
    if (!parsed.ok) return fail(res, 400, parsed.error, { problems: parsed.problems });
    if (parsed.revision !== undefined && parsed.revision !== tag.revision)
      return fail(res, 409, "revision_mismatch", { revision: tag.revision });
    const fields = changed(tag, parsed.value);
    if (fields.length) {
      const at = stamp();
      const count = parsed.value.action.type === tag.action.type ? tag.count : 0;
      store.transaction(() => {
        store.update({ ...tag, ...parsed.value, count }, at);
        store.audit(at, login(req), "update", tag.id, fields);
      });
      afterChange();
    }
    res.json({ ok: true, tag: tagView(store.get(tag.id)!, true) });
  });

  router.delete("/tags/:id", (req, res) => {
    const tag = findTag(req, res);
    if (!tag) return;
    store.remove(tag.id);
    store.audit(stamp(), login(req), "delete", tag.id, []);
    afterChange();
    res.json({ ok: true });
  });

  router.post("/tags/:id/reset", (req, res) => {
    const tag = findTag(req, res);
    if (!tag) return;
    const at = stamp();
    store.transaction(() => {
      store.update({ ...tag, count: 0 }, at);
      store.audit(at, login(req), "reset", tag.id, ["count"]);
    });
    res.json({ ok: true, tag: tagView(store.get(tag.id)!, true) });
  });

  router.post("/tags/:id/public/rotate", (req, res) => {
    const tag = findTag(req, res);
    if (!tag) return;
    const key = newKey();
    const at = stamp();
    store.transaction(() => {
      store.update({ ...tag, key, keyHash: keyHash(key) }, at);
      store.audit(at, login(req), "rotate", tag.id, ["key"]);
    });
    afterChange();
    res.json({ ok: true, tag: tagView(store.get(tag.id)!, true) });
  });

  router.get("/tags/:id/runs", (req, res) => {
    importRuns();
    const tag = findTag(req, res);
    if (!tag) return;
    const p = parsePage(req, res, 20);
    if (p) res.json(page(store.runs(tag.id, p.before, p.limit), p.limit));
  });

  router.get("/runs", (req, res) => {
    importRuns();
    const p = parsePage(req, res, 50);
    if (p) res.json(page(store.runs(null, p.before, p.limit), p.limit));
  });

  router.get("/status", (_req, res) => {
    importRuns();
    const imp = importState();
    res.json({
      ok: true,
      gateway: {
        snapshot: { configured: Boolean(env("COMMONS_NFC_SNAPSHOT_PATH")), ...snapshot },
        runs: {
          configured: Boolean(env("COMMONS_NFC_PUBLIC_DB")),
          importedAt: imp.importedAt,
          error: imp.error,
        },
      },
      backup: backupStatus(),
    });
  });

  router.post("/backup/publish", async (_req, res) => {
    const out = await publishBackup();
    if (out.error) return fail(res, out.status, out.error, out.extra);
    res.json({ ok: true, backup: backupStatus() });
  });

  return router;
}

export default defineAppRouter(({ db, kv, env }) => createNfcRouter({ db, kv, env, background: true }));
