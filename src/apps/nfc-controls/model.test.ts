import { describe, expect, it } from "vitest";
import { createDecipheriv, createHash } from "node:crypto";
import {
  isTagId,
  keyHash,
  KEY_PATTERN,
  newKey,
  newTagId,
  parseAction,
  parseTagBody,
  urlProblem,
} from "./model";
import { backupEntry, backupText, publicAction, snapshotText } from "./publicFiles";
import type { TagRecord } from "./store";

// The contract's test vector ("Static backup copy").
const VECTOR = {
  id: "k7m2q9xpa3b4",
  key: "AAAAAAAAAAAAAAAAAAAAAAAA",
  keyHash: "1bda9f0aed80857d43c9329457f28b1ca29f736a0c539901e1ba16a909eb07b4",
  lookup: "053499967efe7c1f17b9ac389be2d955da6df3d0dff73b01beb6f342772583ba",
  iv: "grJ_jyV7Mhx5lyMC",
  data: "y_ia3OGX_arKiWGrETB8SeiHjrvKvuaqHcxYB8HCDvp1oc7pHf-RcMtbLAI230gWd1m84Q3y5uMh4JWbgwniqWxLivzwKcCcxNg9zTRnJmYCVlqxFzUtme2gqtrVKk2W4GBI0F8c6SU2mRbCo8I610JW213xN6V0BZF0d8q5ok-nViJ0",
};

function tag(over: Partial<TagRecord> = {}): TagRecord {
  return {
    id: VECTOR.id,
    key: VECTOR.key,
    keyHash: VECTOR.keyHash,
    name: "Fridge note",
    enabled: true,
    notes: "private notes",
    action: { type: "note", params: { title: "Hi", text: "Milk", items: [] } },
    count: 7,
    runCount: 9,
    revision: 3,
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    ...over,
  };
}

describe("ids and keys", () => {
  it("makes 12-char ids and 24-char keys", () => {
    for (let i = 0; i < 50; i++) {
      expect(newTagId()).toMatch(/^[a-z0-9]{12}$/);
      expect(newKey()).toMatch(KEY_PATTERN);
    }
    expect(isTagId("fridge-note")).toBe(true);
    expect(isTagId("Fridge")).toBe(false);
    expect(isTagId("a--b")).toBe(false);
    expect(isTagId("a".repeat(33))).toBe(false);
  });

  it("hashes keys as in the contract", () => {
    expect(keyHash(VECTOR.key)).toBe(VECTOR.keyHash);
  });
});

describe("open_url rules", () => {
  it.each([
    "https://example.com/a?b=c",
    "shortcuts://run-shortcut?name=Focus",
    "shortcuts://run-shortcut?name=Log%20water&input=text&text=250",
  ])("accepts %s", (url) => expect(urlProblem(url)).toBeNull());

  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:pw@example.com",
    "shortcuts://run-shortcut?name=X&input=clipboard",
    "shortcuts://open-shortcut?name=X",
    "shortcuts://run-shortcut?name=X&extra=1",
    "shortcuts://run-shortcut?text=x&name=X",
    "shortcuts://run-shortcut",
    "x-apple-reminderkit://",
    `https://example.com/${"a".repeat(2000)}`,
  ])("refuses %s", (url) => expect(urlProblem(url)).not.toBeNull());
});

describe("parseAction / parseTagBody", () => {
  it("drops unknown params and fills note defaults", () => {
    const out = parseAction({ type: "note", params: { text: " Milk ", extra: 1 } });
    expect(out).toEqual({
      ok: true,
      action: { type: "note", params: { title: "", text: "Milk", items: [] } },
    });
    expect(parseAction({ type: "log", params: { label: "Fed the cat", note: "x" } })).toEqual({
      ok: true,
      action: { type: "log", params: { label: "Fed the cat" } },
    });
  });

  it("refuses an empty note and unknown types", () => {
    expect(parseAction({ type: "note", params: { title: "x" } })).toMatchObject({
      ok: false,
      error: "invalid_tag",
    });
    expect(parseAction({ type: "forward", params: {} })).toMatchObject({
      ok: false,
      error: "unknown_action_type",
    });
    expect(parseAction({ type: "toggle" })).toMatchObject({ ok: false, error: "unknown_action_type" });
  });

  it("validates the whole body with problems", () => {
    const out = parseTagBody(
      { id: "Bad Id", name: "", enabled: "yes", action: { type: "log" } },
      { create: true },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.problems.length).toBeGreaterThanOrEqual(4);
    const put = parseTagBody(
      { id: "other", name: "x", action: { type: "log", params: { label: "a" } } },
      {
        create: false,
        urlId: "mine",
      },
    );
    expect(put).toMatchObject({ ok: false, problems: ["id must match the URL"] });
  });
});

describe("snapshot and backup files", () => {
  it("snapshot holds only enabled tags, the projection and the key hash", () => {
    const text = snapshotText(
      [
        tag(),
        tag({ id: "off", enabled: false }),
        tag({ id: "c", action: { type: "log", params: { label: "L" } } }),
      ],
      "2026-11-27T00:00:00.000Z",
    );
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.tags.map((t: { id: string }) => t.id)).toEqual([VECTOR.id, "c"]);
    expect(parsed.tags[0]).toEqual({
      id: VECTOR.id,
      name: "Fridge note",
      keyHash: VECTOR.keyHash,
      action: { type: "note", params: { title: "Hi", text: "Milk", items: [] } },
    });
    expect(text).not.toContain(VECTOR.key);
    expect(text).not.toContain("private notes");
    expect(text).not.toMatch(/count|revision|notes/);
  });

  it("matches the contract's backup test vector and decrypts", () => {
    const e = backupEntry(tag());
    expect(e).toEqual({ lookup: VECTOR.lookup, iv: VECTOR.iv, data: VECTOR.data });
    const aesKey = createHash("sha256")
      .update(`commons-nfc-backup/v1/key\n${VECTOR.id}\n${VECTOR.key}`)
      .digest();
    const raw = Buffer.from(e.data, "base64url");
    const d = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(e.iv, "base64url"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8");
    expect(JSON.parse(plain)).toEqual({
      id: VECTOR.id,
      name: "Fridge note",
      action: publicAction(tag().action),
    });
  });

  it("backup leaves out log and disabled tags and reveals nothing in clear", () => {
    const { text, count } = backupText([
      tag(),
      tag({ id: "logtag", action: { type: "log", params: { label: "L" } } }),
      tag({ id: "off", enabled: false }),
    ]);
    expect(count).toBe(1);
    expect(text).not.toMatch(/Fridge|Milk|k7m2q9xpa3b4|logtag/);
    expect(Object.keys(JSON.parse(text).tags)).toEqual([VECTOR.lookup]);
    // Deterministic: the same tags publish the same bytes.
    expect(backupText([tag()]).text).toBe(backupText([tag()]).text);
  });
});
