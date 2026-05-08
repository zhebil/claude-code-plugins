import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSeenIds, saveSeenIds } from "../../../hooks/lib/cache.mjs";

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

describe("loadSeenIds", () => {
  it("returns empty seen-set when cache file is absent", async () => {
    const { allSessions, seen } = await loadSeenIds("session-1");
    assert.deepEqual(allSessions, {});
    assert.equal(seen.size, 0);
  });

  it("loads previously saved ids for the same session", async () => {
    const { allSessions, seen } = await loadSeenIds("session-1");
    seen.add("a");
    seen.add("b");
    await saveSeenIds(allSessions, "session-1", seen);

    const reloaded = await loadSeenIds("session-1");
    assert.deepEqual([...reloaded.seen].sort(), ["a", "b"]);
  });

  it("isolates ids between sessions", async () => {
    const first = await loadSeenIds("session-1");
    first.seen.add("a");
    await saveSeenIds(first.allSessions, "session-1", first.seen);

    const second = await loadSeenIds("session-2");
    assert.equal(second.seen.size, 0);
    second.seen.add("b");
    await saveSeenIds(second.allSessions, "session-2", second.seen);

    const reloadedFirst = await loadSeenIds("session-1");
    assert.deepEqual([...reloadedFirst.seen].sort(), ["a"]);
  });
});

describe("saveSeenIds", () => {
  it("writes JSON keyed by session", async () => {
    const { allSessions, seen } = await loadSeenIds("s");
    seen.add("x");
    await saveSeenIds(allSessions, "s", seen);

    const raw = await readFile(join(tempDir, "seen.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, { s: ["x"] });
  });

  it("caps each session to 200 newest ids", async () => {
    const { allSessions, seen } = await loadSeenIds("s");
    for (let i = 0; i < 250; i++) seen.add(`id-${i}`);
    await saveSeenIds(allSessions, "s", seen);

    const reloaded = await loadSeenIds("s");
    assert.equal(reloaded.seen.size, 200);
    assert.ok(reloaded.seen.has("id-249"));
    assert.ok(!reloaded.seen.has("id-0"));
  });
});
