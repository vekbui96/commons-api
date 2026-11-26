import { Router, type Response } from "express";
import { defineAppRouter, type AppKv } from "../../core";
import { pagesUrl, PublishError, putFile, REPO_PATTERN, type PublishTarget } from "./github";
import {
  cleanContent,
  contentKey,
  crossProblems,
  fileText,
  GUEST,
  isProfileId,
  parseAppList,
  parseProfileBody,
  SEED,
  type Draft,
  type ProfilesContent,
} from "./model";

export const DEFAULT_REPO = "vekbui96/commons-profiles";
export const FILE_PATH = "profiles.json";
export const BRANCH = "main";

/** KV `published`: the last publish and the last attempt. `content` is the baseline for the dirty flag. */
export interface PublishRecord {
  revision: number | null;
  publishedAt: string | null;
  commitSha: string | null;
  content: ProfilesContent;
  lastAttemptAt: string | null;
  lastError: { error: string; status?: number; at: string } | null;
}

export interface ProfilesDeps {
  kv: AppKv;
  env: (name: string) => string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ ok: false, error, ...extra });
}

export function createProfilesRouter({
  kv,
  env,
  fetch: fetchFn = fetch,
  now = () => new Date(),
  log = (msg) => console.log(`${new Date().toISOString()} profiles: ${msg}`),
}: ProfilesDeps): Router {
  const stamp = () => now().toISOString();

  // Seed once: the iteration-1 content, recorded as the published baseline (so not dirty).
  if (kv.get<Draft>("draft") === undefined) {
    kv.set("draft", { revision: 1, updatedAt: stamp(), ...cleanContent(SEED) } satisfies Draft);
    kv.set("published", {
      revision: null,
      publishedAt: null,
      commitSha: null,
      content: cleanContent(SEED),
      lastAttemptAt: null,
      lastError: null,
    } satisfies PublishRecord);
  }
  const draft = () => kv.get<Draft>("draft")!;
  const record = () => kv.get<PublishRecord>("published")!;
  const dirty = (d: Draft) => contentKey(d) !== contentKey(record().content);

  const target = (): (Omit<PublishTarget, "token"> & { token: string | undefined }) | null => {
    const repo = env("COMMONS_PROFILES_REPO") ?? DEFAULT_REPO;
    if (!REPO_PATTERN.test(repo)) return null;
    return { repo, path: FILE_PATH, branch: BRANCH, token: env("COMMONS_PROFILES_TOKEN") };
  };

  const state = (d: Draft = draft()) => ({
    ok: true,
    revision: d.revision,
    updatedAt: d.updatedAt,
    dirty: dirty(d),
    ...cleanContent(d),
  });

  /** Validates the whole new content and saves it as the next revision (unchanged content: no bump). */
  const save = (res: Response, next: ProfilesContent, created = false) => {
    const problems = crossProblems(next);
    if (problems.length) return fail(res, 400, "invalid_profiles", { problems });
    const current = draft();
    let d = current;
    if (contentKey(next) !== contentKey(current)) {
      d = { revision: current.revision + 1, updatedAt: stamp(), ...cleanContent(next) };
      kv.set("draft", d);
    }
    res.status(created ? 201 : 200).json(state(d));
  };

  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/profiles", (_req, res) => {
    res.json(state());
  });

  router.put("/profiles/:id", (req, res) => {
    const id = req.params.id;
    if (id === GUEST) return fail(res, 400, "guest_reserved");
    const problems: string[] = [];
    const profile = parseProfileBody(id, req.body, problems);
    if (!profile) return fail(res, 400, "invalid_profile", { problems });
    const current = draft();
    const index = current.profiles.findIndex((p) => p.id === id);
    const profiles = [...current.profiles];
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    save(res, { guest: current.guest, profiles }, index < 0);
  });

  router.delete("/profiles/:id", (req, res) => {
    const id = req.params.id;
    if (id === GUEST) return fail(res, 400, "guest_reserved");
    const current = draft();
    if (!isProfileId(id) || !current.profiles.some((p) => p.id === id))
      return fail(res, 404, "profile_not_found");
    save(res, { guest: current.guest, profiles: current.profiles.filter((p) => p.id !== id) });
  });

  router.put("/guest", (req, res) => {
    const body: unknown = req.body;
    const problems: string[] = [];
    if (typeof body !== "object" || body === null || Array.isArray(body))
      problems.push("the body must be a JSON object");
    const apps = parseAppList((body as { apps?: unknown } | null)?.apps, "apps", problems);
    if (problems.length) return fail(res, 400, "invalid_guest", { problems });
    save(res, { guest: { apps }, profiles: draft().profiles });
  });

  router.get("/export", (_req, res) => {
    res
      .type("application/json; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${FILE_PATH}"`)
      .send(fileText(draft()));
  });

  const publishStatus = () => {
    const t = target();
    const r = record();
    const d = draft();
    return {
      ok: true,
      configured: Boolean(t?.token),
      repo: t?.repo ?? null,
      path: FILE_PATH,
      branch: BRANCH,
      url: t ? pagesUrl(t.repo, FILE_PATH) : null,
      revision: d.revision,
      dirty: dirty(d),
      lastPublished: r.publishedAt
        ? { revision: r.revision, publishedAt: r.publishedAt, commitSha: r.commitSha }
        : null,
      lastAttemptAt: r.lastAttemptAt,
      lastError: r.lastError,
    };
  };

  router.get("/publish", (_req, res) => {
    res.json(publishStatus());
  });

  let publishing = false;
  router.post("/publish", async (req, res) => {
    const t = target();
    if (!t?.token) return fail(res, 503, "publish_not_configured");
    const d = draft();
    const wanted = (req.body as { revision?: unknown } | undefined)?.revision;
    if (wanted !== undefined && wanted !== d.revision)
      return fail(res, 409, "revision_mismatch", { revision: d.revision });
    if (publishing) return fail(res, 409, "publish_in_progress");
    publishing = true;
    const at = stamp();
    try {
      const result = await putFile(
        fetchFn,
        { ...t, token: t.token },
        fileText(d),
        `Publish profiles revision ${d.revision} from Commons`,
      );
      const before = record();
      kv.set("published", {
        revision: d.revision,
        publishedAt: at,
        commitSha: result.unchanged ? before.commitSha : result.commitSha,
        content: cleanContent(d),
        lastAttemptAt: at,
        lastError: null,
      } satisfies PublishRecord);
      log(`published revision ${d.revision}${result.unchanged ? " (file already up to date)" : ""}`);
      res.json({ ...publishStatus(), unchanged: result.unchanged });
    } catch (err) {
      const code = err instanceof PublishError ? err.code : "github_error";
      const status = err instanceof PublishError ? err.status : undefined;
      kv.set("published", {
        ...record(),
        lastAttemptAt: at,
        lastError: { error: code, ...(status ? { status } : {}), at },
      } satisfies PublishRecord);
      log(`publish of revision ${d.revision} failed: ${code}${status ? ` (${status})` : ""}`);
      fail(res, 502, "publish_failed", { reason: code, ...(status ? { status } : {}) });
    } finally {
      publishing = false;
    }
  });

  return router;
}

export default defineAppRouter(({ kv, env }) => createProfilesRouter({ kv, env }));
