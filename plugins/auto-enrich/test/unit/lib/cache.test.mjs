import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSeenIds,
  popCompactStash,
  saveSeenItems,
  stashForCompact,
} from "../../../hooks/lib/cache.mjs";

let tempDir;
const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "auto-enrich-cache-test-"));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
  await rm(tempDir, { recursive: true, force: true });
});

const item = (id) => ({ id, summary: `s ${id}` });

describe("loadSeenIds", () => {
  it("returns empty seen-set when cache file is absent", async () => {
    const { all, seen } = await loadSeenIds("session-1");
    assert.deepEqual(all.sessions, {});
    assert.deepEqual(all.stashed, {});
    assert.equal(seen.size, 0);
  });

  it("loads previously saved ids for the same session", async () => {
    const { all } = await loadSeenIds("session-1");
    await saveSeenItems(all, "session-1", [item("a"), item("b")]);

    const reloaded = await loadSeenIds("session-1");
    assert.deepEqual([...reloaded.seen].sort(), ["a", "b"]);
  });

  it("isolates ids between sessions", async () => {
    const first = await loadSeenIds("session-1");
    await saveSeenItems(first.all, "session-1", [item("a")]);

    const second = await loadSeenIds("session-2");
    assert.equal(second.seen.size, 0);
    await saveSeenItems(second.all, "session-2", [item("b")]);

    const reloadedFirst = await loadSeenIds("session-1");
    assert.deepEqual([...reloadedFirst.seen].sort(), ["a"]);
  });
});

describe("saveSeenItems", () => {
  it("writes JSON keyed by session under sessions[]", async () => {
    const { all } = await loadSeenIds("s");
    await saveSeenItems(all, "s", [item("x")]);

    const raw = await readFile(join(tempDir, "seen.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, {
      sessions: { s: [{ id: "x", summary: "s x" }] },
      stashed: {},
    });
  });

  it("caps each session to 200 newest items", async () => {
    const { all } = await loadSeenIds("s");
    const items = Array.from({ length: 250 }, (_, i) => item(`id-${i}`));
    await saveSeenItems(all, "s", items);

    const reloaded = await loadSeenIds("s");
    assert.equal(reloaded.seen.size, 200);
    assert.ok(reloaded.seen.has("id-249"));
    assert.ok(!reloaded.seen.has("id-0"));
  });
});

describe("stashForCompact", () => {
  it("moves a session's items into stashed[] and clears active entry", async () => {
    const { all } = await loadSeenIds("s");
    await saveSeenItems(all, "s", [item("a"), item("b")]);

    await stashForCompact("s");

    const raw = JSON.parse(await readFile(join(tempDir, "seen.json"), "utf8"));
    assert.deepEqual(raw.sessions, {});
    assert.deepEqual(raw.stashed, {
      s: [{ id: "a", summary: "s a" }, { id: "b", summary: "s b" }],
    });
  });

  it("is a no-op when the session has no items", async () => {
    await stashForCompact("never-existed");
    const { all, seen } = await loadSeenIds("never-existed");
    assert.deepEqual(all.sessions, {});
    assert.deepEqual(all.stashed, {});
    assert.equal(seen.size, 0);
  });

  it("does not disturb other sessions' active entries", async () => {
    const { all } = await loadSeenIds("a");
    await saveSeenItems(all, "a", [item("a1")]);
    const next = await loadSeenIds("b");
    await saveSeenItems(next.all, "b", [item("b1")]);

    await stashForCompact("a");

    const reloadedB = await loadSeenIds("b");
    assert.deepEqual([...reloadedB.seen], ["b1"]);
  });
});

describe("popCompactStash", () => {
  it("returns an empty array when nothing was stashed", async () => {
    assert.deepEqual(await popCompactStash("s"), []);
  });

  it("returns stashed items and removes the entry", async () => {
    const { all } = await loadSeenIds("s");
    await saveSeenItems(all, "s", [item("a"), item("b")]);
    await stashForCompact("s");

    const first = await popCompactStash("s");
    assert.deepEqual(first, [
      { id: "a", summary: "s a" },
      { id: "b", summary: "s b" },
    ]);

    const second = await popCompactStash("s");
    assert.deepEqual(second, []);
  });
});
