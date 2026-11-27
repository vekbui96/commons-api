/**
 * Tag shape and validation for NFC controls v1 (contract: docs/nfc-controls-contract.md).
 * The gateway (vekbui96/commons-public) re-checks the same rules on everything it serves.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

export const ACTION_TYPES = ["open_url", "log", "note"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface OpenUrlParams {
  url: string;
  label: string;
}
export interface LogParams {
  label: string;
}
export interface NoteParams {
  title: string;
  text: string;
  items: string[];
}
export type Action =
  | { type: "open_url"; params: OpenUrlParams }
  | { type: "log"; params: LogParams }
  | { type: "note"; params: NoteParams };

export const TAG_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{24}$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- as above, newlines allowed
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

export function isTagId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 1 && id.length <= 32 && TAG_ID.test(id);
}

/** 12 random characters from [a-z0-9]. */
export function newTagId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 12; i++) id += alphabet[randomInt(alphabet.length)];
  return id;
}

/** 24 characters base64url (18 random bytes, 144 bits). */
export function newKey(): string {
  return randomBytes(18).toString("base64url");
}

/** Lowercase hex SHA-256 of the key's UTF-8 bytes: the only form of the key that leaves this database. */
export function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function text(
  raw: unknown,
  field: string,
  problems: string[],
  { min, max, multiline = false }: { min: number; max: number; multiline?: boolean },
): string {
  if (raw === undefined && min === 0) return "";
  if (typeof raw !== "string") {
    problems.push(`${field} must be a string`);
    return "";
  }
  const value = multiline ? raw.replace(/\r\n/g, "\n").trim() : raw.trim();
  if (value.length < min || value.length > max)
    problems.push(
      min ? `${field} must be ${min}-${max} characters` : `${field} must be at most ${max} characters`,
    );
  else if ((multiline ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(value))
    problems.push(`${field} must not contain control characters`);
  return value;
}

const SHORTCUT_PARAMS = new Set(["name", "input", "text"]);

/** https with a host and no user info, or shortcuts://run-shortcut?name=..[&input=text&text=..]. */
export function urlProblem(raw: string): string | null {
  if (raw.length > 2000) return "url must be at most 2000 characters";
  if (/\s/.test(raw)) return "url must not contain spaces";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url is not a valid URL";
  }
  if (url.protocol === "https:") {
    if (!url.hostname) return "url needs a host";
    if (url.username || url.password) return "url must not contain a user name or password";
    return null;
  }
  if (url.protocol === "shortcuts:") {
    if (url.host !== "run-shortcut" || (url.pathname !== "" && url.pathname !== "/"))
      return "a shortcuts: url must be shortcuts://run-shortcut?name=...";
    const keys = [...url.searchParams.keys()];
    if (keys.some((k) => !SHORTCUT_PARAMS.has(k)) || new Set(keys).size !== keys.length)
      return "a shortcuts: url may only have name, input=text and text";
    const name = url.searchParams.get("name");
    if (!name || !name.trim()) return "a shortcuts: url needs a shortcut name";
    const input = url.searchParams.get("input");
    if (input !== null && input !== "text") return "a shortcuts: url may only use input=text";
    if (url.searchParams.has("text") && input !== "text") return "text needs input=text";
    return null;
  }
  return "url must start with https:// or shortcuts://run-shortcut";
}

export type ParsedAction = { ok: true; action: Action } | { ok: false; error: string; problems: string[] };

export function parseAction(raw: unknown): ParsedAction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "invalid_tag", problems: ["action must be an object"] };
  const { type, params } = raw as { type?: unknown; params?: unknown };
  if (typeof type !== "string" || !(ACTION_TYPES as readonly string[]).includes(type))
    return {
      ok: false,
      error: "unknown_action_type",
      problems: [`action.type must be one of ${ACTION_TYPES.join(", ")}`],
    };
  const p = (typeof params === "object" && params !== null && !Array.isArray(params) ? params : {}) as Record<
    string,
    unknown
  >;
  const problems: string[] = [];
  if (params !== undefined && p !== params) problems.push("action.params must be an object");
  let action: Action;
  if (type === "open_url") {
    const url = text(p.url, "action.params.url", problems, { min: 1, max: 2000 });
    if (url && !problems.length) {
      const bad = urlProblem(url);
      if (bad) problems.push(`action.params.${bad}`);
    }
    action = {
      type,
      params: { url, label: text(p.label, "action.params.label", problems, { min: 1, max: 60 }) },
    };
  } else if (type === "log") {
    action = { type, params: { label: text(p.label, "action.params.label", problems, { min: 1, max: 60 }) } };
  } else {
    const title = text(p.title, "action.params.title", problems, { min: 0, max: 80 });
    const body = text(p.text, "action.params.text", problems, { min: 0, max: 4000, multiline: true });
    let items: string[] = [];
    if (p.items !== undefined) {
      if (!Array.isArray(p.items) || p.items.length > 50)
        problems.push("action.params.items must be a list of at most 50 strings");
      else
        items = p.items.map((item, i) =>
          text(item, `action.params.items[${i}]`, problems, { min: 1, max: 200 }),
        );
    }
    if (!body && !items.length) problems.push("a note needs text or at least one item");
    action = { type: "note", params: { title, text: body, items } };
  }
  return problems.length ? { ok: false, error: "invalid_tag", problems } : { ok: true, action };
}

export interface TagInput {
  name: string;
  action: Action;
  enabled: boolean;
  notes: string;
}

export type ParsedTag =
  | { ok: true; value: TagInput; id?: string; revision?: number }
  | { ok: false; error: string; problems: string[] };

/** Body of POST /tags (`create`) or PUT /tags/:id (`urlId`). Unknown keys are ignored. */
export function parseTagBody(
  raw: unknown,
  mode: { create: true } | { create: false; urlId: string },
): ParsedTag {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "invalid_tag", problems: ["the body must be a JSON object"] };
  const body = raw as Record<string, unknown>;
  const problems: string[] = [];
  let id: string | undefined;
  if (mode.create) {
    if (body.id !== undefined) {
      if (isTagId(body.id)) id = body.id;
      else problems.push("id must be 1-32 characters: a-z, 0-9 and single dashes");
    }
  } else if (body.id !== undefined && body.id !== mode.urlId) problems.push("id must match the URL");
  let revision: number | undefined;
  if (!mode.create && body.revision !== undefined) {
    if (Number.isSafeInteger(body.revision) && (body.revision as number) >= 1)
      revision = body.revision as number;
    else problems.push("revision must be a positive whole number");
  }
  const name = text(body.name, "name", problems, { min: 1, max: 60 });
  const notes = text(body.notes, "notes", problems, { min: 0, max: 2000, multiline: true });
  let enabled = true;
  if (body.enabled !== undefined) {
    if (typeof body.enabled === "boolean") enabled = body.enabled;
    else problems.push("enabled must be true or false");
  }
  const action = parseAction(body.action);
  if (!action.ok) {
    if (action.error === "unknown_action_type" && !problems.length) return action;
    problems.push(...action.problems);
  }
  if (problems.length || !action.ok) return { ok: false, error: "invalid_tag", problems };
  return { ok: true, value: { name, action: action.action, enabled, notes }, id, revision };
}

export const RUN_CODES = ["opened", "shown", "counted", "deduped", "capped"] as const;
export type RunCode = (typeof RUN_CODES)[number];

/** Messages are written here from the code, never taken from the gateway. */
export const RUN_MESSAGES: Record<RunCode, string> = {
  opened: "Link opened",
  shown: "Note shown",
  counted: "Counted",
  deduped: "Not counted: same visitor within 60 s",
  capped: "Not counted: daily cap reached",
};

/** Which run codes go with which action type. */
export const CODES_FOR: Record<ActionType, readonly RunCode[]> = {
  open_url: ["opened"],
  note: ["shown"],
  log: ["counted", "deduped", "capped"],
};
