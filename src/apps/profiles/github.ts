/**
 * Writes one file to a GitHub repo through the contents API. The token is only
 * ever put in the Authorization header: never logged, stored or returned, and
 * errors carry a code (and the HTTP status) only, never GitHub's message.
 */

export interface PublishTarget {
  /** "owner/name". */
  repo: string;
  path: string;
  branch: string;
  token: string;
}

export type PublishErrorCode =
  | "github_unauthorized"
  | "github_forbidden"
  | "github_not_found"
  | "github_conflict"
  | "github_error"
  | "github_unreachable";

export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    readonly status?: number,
  ) {
    super(status ? `${code} (${status})` : code);
    this.name = "PublishError";
  }
}

export interface PutResult {
  /** The commit GitHub made; null when the file already held these bytes (no commit). */
  commitSha: string | null;
  unchanged: boolean;
}

export const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const TIMEOUT_MS = 15000;

function codeFor(status: number): PublishErrorCode {
  if (status === 401) return "github_unauthorized";
  if (status === 403) return "github_forbidden";
  if (status === 404) return "github_not_found";
  if (status === 409 || status === 422) return "github_conflict";
  return "github_error";
}

/** The public Pages URL a repo serves the file at: https://<owner>.github.io/<name>/<path>. */
export function pagesUrl(repo: string, path: string): string {
  const [owner, name] = repo.split("/");
  return `https://${owner!.toLowerCase()}.github.io/${name}/${path}`;
}

export async function putFile(
  fetchFn: typeof fetch,
  target: PublishTarget,
  text: string,
  message: string,
): Promise<PutResult> {
  const url = `https://api.github.com/repos/${target.repo}/contents/${target.path}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${target.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "commons-api",
  };
  const call = async (input: string, init: RequestInit = {}) => {
    try {
      return await fetchFn(input, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new PublishError("github_unreachable");
    }
  };

  // Two tries: a conflict (someone else changed the file between read and write) re-reads once.
  for (let attempt = 0; ; attempt++) {
    const current = await call(`${url}?ref=${encodeURIComponent(target.branch)}`);
    let sha: string | undefined;
    if (current.status === 200) {
      const body = (await current.json()) as { sha?: string; content?: string; encoding?: string };
      sha = body.sha;
      if (body.encoding === "base64" && typeof body.content === "string") {
        const existing = Buffer.from(body.content.replace(/\s/g, ""), "base64").toString("utf8");
        if (existing === text) return { commitSha: null, unchanged: true };
      }
    } else if (current.status !== 404) {
      throw new PublishError(codeFor(current.status), current.status);
    }

    const put = await call(url, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: Buffer.from(text, "utf8").toString("base64"),
        branch: target.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.status === 200 || put.status === 201) {
      const body = (await put.json()) as { commit?: { sha?: string } };
      return { commitSha: body.commit?.sha ?? null, unchanged: false };
    }
    const code = codeFor(put.status);
    if (code === "github_conflict" && attempt === 0) continue;
    throw new PublishError(code, put.status);
  }
}
