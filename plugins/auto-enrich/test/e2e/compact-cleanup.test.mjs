import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENRICH_HOOK = resolve(HERE, "../../hooks/auto-enrich.mjs");
const COMPACT_HOOK = resolve(HERE, "../../hooks/compact-cleanup.mjs");

let stubBinDir;
let cacheDir;

beforeEach(async () => {
  stubBinDir = await mkdtemp(join(tmpdir(), "auto-enrich-compact-bin-"));
  cacheDir = await mkdtemp(join(tmpdir(), "auto-enrich-compact-cache-"));
});

afterEach(async () => {
  await rm(stubBinDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

async function writeStub(name, body) {
  const path = join(stubBinDir, name);
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
}

function runHook(hookPath, payload) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        PATH: `${stubBinDir}:${process.env.PATH}`,
        CLAUDE_PLUGIN_DATA: cacheDir,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolveRun({ stdout, stderr, code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("compact-cleanup hook (e2e)", () => {
  it("PreCompact stashes seen items so the next prompt can re-enrich the same ref", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/issues/3")
    echo '{"title":"X","state":"open","user":{"login":"a"}}'
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const sid = "compact-1";
    const prompt = "https://github.com/me/proj/issues/3";

    const first = await runHook(ENRICH_HOOK, {
      session_id: sid,
      cwd: process.cwd(),
      user_prompt: prompt,
    });
    assert.notEqual(first.stdout, "");

    // Without compact, a second prompt is suppressed by dedup.
    const second = await runHook(ENRICH_HOOK, {
      session_id: sid,
      cwd: process.cwd(),
      user_prompt: prompt,
    });
    assert.equal(second.stdout, "");

    // PreCompact runs - dedup memory is cleared.
    const preCompact = await runHook(COMPACT_HOOK, {
      session_id: sid,
      hook_event_name: "PreCompact",
      trigger: "manual",
    });
    assert.equal(preCompact.code, 0);
    assert.equal(preCompact.stdout, "");

    // Now the same ref enriches again on the next prompt.
    const third = await runHook(ENRICH_HOOK, {
      session_id: sid,
      cwd: process.cwd(),
      user_prompt: prompt,
    });
    assert.notEqual(third.stdout, "");
    const parsed = JSON.parse(third.stdout);
    assert.match(parsed.systemMessage, /gh me\/proj#3/);
  });

  it("SessionStart with source=compact emits a references-only additionalContext", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/issues/3")
    echo '{"title":"X","state":"open","user":{"login":"a"},"body":"long body that should NOT be re-emitted after compact"}'
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const sid = "compact-2";

    // Seed the session with one enriched item.
    await runHook(ENRICH_HOOK, {
      session_id: sid,
      cwd: process.cwd(),
      user_prompt: "https://github.com/me/proj/issues/3",
    });

    // PreCompact moves it into the stash.
    await runHook(COMPACT_HOOK, {
      session_id: sid,
      hook_event_name: "PreCompact",
      trigger: "manual",
    });

    // SessionStart on compact drains the stash.
    const start = await runHook(COMPACT_HOOK, {
      session_id: sid,
      hook_event_name: "SessionStart",
      source: "compact",
    });
    assert.equal(start.code, 0);
    const parsed = JSON.parse(start.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /Previously auto-enriched references/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /github:me\/proj#3/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /gh me\/proj#3/);
    // Critically, the full body must NOT be re-emitted.
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /long body/);

    // Calling SessionStart again is a no-op (stash already drained).
    const second = await runHook(COMPACT_HOOK, {
      session_id: sid,
      hook_event_name: "SessionStart",
      source: "compact",
    });
    assert.equal(second.stdout, "");
  });

  it("SessionStart with non-compact source is a no-op", async () => {
    const result = await runHook(COMPACT_HOOK, {
      session_id: "any",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("PreCompact on a session with nothing seen is a no-op", async () => {
    const result = await runHook(COMPACT_HOOK, {
      session_id: "fresh",
      hook_event_name: "PreCompact",
      trigger: "manual",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });
});
