/**
 * Visitor profiles: the data, its rules and the published file. The rules match
 * the front end's parseProfiles (vekbui96/commons, src/profiles/validate.ts),
 * plus length and count limits, so whatever this app publishes the site accepts.
 */

export interface Profile {
  id: string;
  name: string;
  aliases: string[];
  inheritsGuest: boolean;
  apps: string[];
}

/** What the profiles are: the guest's apps and the named profiles, in order. */
export interface ProfilesContent {
  guest: { apps: string[] };
  profiles: Profile[];
}

/** The working copy (KV `draft`). `revision` goes up by one on every change. */
export interface Draft extends ProfilesContent {
  revision: number;
  updatedAt: string;
}

export const ID_MAX = 32;
export const NAME_MAX = 40;
export const ALIAS_MAX = 40;
export const APP_ID_MAX = 64;
export const MAX_PROFILES = 100;
export const MAX_ALIASES = 10;
export const MAX_APPS = 50;
/** Picks the guest view on the site, so no profile may use it as an id, name or alias. */
export const GUEST = "guest";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The iteration-1 file as published (vekbui96/commons-profiles), so a fresh seed is not dirty. */
export const SEED: ProfilesContent = {
  guest: { apps: ["portfolio"] },
  profiles: [{ id: "tammy", name: "Tammy", aliases: [], inheritsGuest: true, apps: ["units", "cardlens"] }],
};

/** "  Tâmmy " -> "tammy": the front end's normaliseName, exactly. */
export function normaliseName(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
}

export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && value.length <= ID_MAX && KEBAB.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list of app ids: kebab-case strings, no repeats. */
export function parseAppList(value: unknown, where: string, problems: string[]): string[] {
  if (!Array.isArray(value)) {
    problems.push(`${where} must be an array of app ids`);
    return [];
  }
  if (value.length > MAX_APPS) problems.push(`${where} may list at most ${MAX_APPS} apps`);
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.length > APP_ID_MAX || !KEBAB.test(id))
      problems.push(`${where} has a bad app id: ${JSON.stringify(id)}`);
    else if (ids.includes(id)) problems.push(`${where} lists "${id}" twice`);
    else ids.push(id);
  }
  return ids;
}

/**
 * A profile from a request body; the id comes from the URL. `aliases` defaults
 * to [] and `inheritsGuest` to true. Names and aliases are trimmed.
 */
export function parseProfileBody(id: string, body: unknown, problems: string[]): Profile | null {
  if (!isProfileId(id)) problems.push(`id must be kebab-case, ${ID_MAX} characters or fewer`);
  if (!isRecord(body)) {
    problems.push("the body must be a JSON object");
    return null;
  }
  if (body.id !== undefined && body.id !== id)
    problems.push("id in the body must match the URL (ids cannot change)");

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (typeof body.name !== "string" || name === "" || name.length > NAME_MAX)
    problems.push(`name must be 1-${NAME_MAX} characters`);

  const aliases: string[] = [];
  const rawAliases = body.aliases ?? [];
  if (!Array.isArray(rawAliases)) problems.push("aliases must be an array of names");
  else {
    if (rawAliases.length > MAX_ALIASES) problems.push(`aliases may hold at most ${MAX_ALIASES} names`);
    for (const alias of rawAliases) {
      const trimmed = typeof alias === "string" ? alias.trim() : "";
      if (trimmed === "" || trimmed.length > ALIAS_MAX)
        problems.push(`aliases has a bad name: ${JSON.stringify(alias)} (1-${ALIAS_MAX} characters)`);
      else aliases.push(trimmed);
    }
  }

  const inheritsGuest = body.inheritsGuest ?? true;
  if (typeof inheritsGuest !== "boolean") problems.push("inheritsGuest must be true or false");
  const apps = parseAppList(body.apps, "apps", problems);
  if (problems.length) return null;
  return { id, name, aliases, inheritsGuest: inheritsGuest as boolean, apps };
}

/**
 * Rules across profiles: every id, name and alias picks exactly one profile once
 * normalised, and none picks the guest view. Repeats inside one profile are fine
 * (the front end allows them too).
 */
export function crossProblems(content: ProfilesContent): string[] {
  const problems: string[] = [];
  if (content.profiles.length > MAX_PROFILES) problems.push(`at most ${MAX_PROFILES} profiles`);
  const taken = new Map<string, string>([[GUEST, "the guest view"]]);
  for (const profile of content.profiles) {
    for (const key of new Set([profile.id, profile.name, ...profile.aliases].map(normaliseName))) {
      const owner = taken.get(key);
      if (owner) problems.push(`profile "${profile.id}": "${key}" already picks ${owner}`);
      else taken.set(key, `profile "${profile.id}"`);
    }
  }
  return problems;
}

/** Order-preserving comparison key for the content (dirty flag). */
export function contentKey(content: ProfilesContent): string {
  return JSON.stringify(cleanContent(content));
}

/** The content with keys in the published order and nothing else. */
export function cleanContent(content: ProfilesContent): ProfilesContent {
  return {
    guest: { apps: [...content.guest.apps] },
    profiles: content.profiles.map(({ id, name, aliases, inheritsGuest, apps }) => ({
      id,
      name,
      aliases: [...aliases],
      inheritsGuest,
      apps: [...apps],
    })),
  };
}

/**
 * The exact profiles.json text: the iteration-1 shape plus `revision`, which the
 * front end's parseProfiles ignores (it keeps known top-level keys only).
 */
export function fileText(draft: Draft): string {
  const { guest, profiles } = cleanContent(draft);
  return `${JSON.stringify({ version: 1, revision: draft.revision, guest, profiles }, null, 2)}\n`;
}
