import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function writeConfig(dir, payload) {
  await writeFile(join(dir, "config.json"), JSON.stringify(payload));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(HERE, "../../hooks/auto-enrich.mjs");

let stubBinDir;
let cacheDir;

beforeEach(async () => {
  stubBinDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-bin-"));
  cacheDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-cache-"));
});

afterEach(async () => {
  await rm(stubBinDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

/**
 * Write an executable shell script under the stub bin dir. The body is a
 * bash `case` statement keyed on the joined argv ($*).
 *
 * @param {string} name CLI name (e.g. "gh").
 * @param {string} body Bash body.
 */
async function writeStub(name, body) {
  const path = join(stubBinDir, name);
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
}

/**
 * Spawn the hook with a synthetic stdin payload and stub PATH.
 *
 * @param {Object} payload Claude Code hook payload.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function runHook(payload) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: {
        ...process.env,
        PATH: `${stubBinDir}:${process.env.PATH}`,
        CLAUDE_PLUGIN_DATA: cacheDir,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolveRun({ stdout, stderr, code });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("auto-enrich hook (e2e)", () => {
  it("enriches a GitHub issue URL via stubbed gh", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/issues/3")
    cat <<'JSON'
{"title":"Hello","state":"open","user":{"login":"alice"},"html_url":"https://github.com/me/proj/issues/3","body":"issue body"}
JSON
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-1",
      cwd: process.cwd(),
      user_prompt: "look at https://github.com/me/proj/issues/3",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: gh me\/proj#3/m);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.suppressOutput, false);
    assert.equal(parsed.systemMessage, "Auto-enriched: gh me/proj#3");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(parsed.hookSpecificOutput.additionalContext, /Issue me\/proj#3: Hello/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /issue body/);
  });

  it("enriches a Jira key via stubbed acli", async () => {
    await writeStub(
      "acli",
      `
case "$*" in
  "jira workitem view PROJ-1 --json")
    cat <<'JSON'
{"url":"https://acme.atlassian.net/browse/PROJ-1","fields":{"summary":"Title","status":{"name":"Open"},"issuetype":{"name":"Task"},"assignee":{"displayName":"Alice"},"description":"plain"}}
JSON
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-2",
      cwd: process.cwd(),
      user_prompt: "ticket PROJ-1 needs fixing",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: jira PROJ-1/m);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.systemMessage, "Auto-enriched: jira PROJ-1");
    assert.match(parsed.hookSpecificOutput.additionalContext, /Jira PROJ-1: Title/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Assignee: Alice/);
  });

  it("enriches a Sentry URL via stubbed sentry CLI", async () => {
    await writeStub(
      "sentry",
      `
case "$*" in
  "api /api/0/issues/9/")
    cat <<'JSON'
{"title":"Boom","permalink":"https://sentry.io/issues/9/","level":"error","status":"unresolved","count":2,"userCount":1}
JSON
    ;;
  "api /api/0/issues/9/events/latest/")
    cat <<'JSON'
{"eventID":"abc","tags":[{"key":"environment","value":"prod"}],"entries":[]}
JSON
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-3",
      cwd: process.cwd(),
      user_prompt: "see https://sentry.io/issues/9/",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: sentry 9/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Sentry issue 9: Boom/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- environment: prod/);
  });

  it("emits nothing for plain prompts with no references", async () => {
    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-4",
      cwd: process.cwd(),
      user_prompt: "hello there, no references here",
    });

    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("does NOT enrich references inside backticks", async () => {
    await writeStub(
      "gh",
      `echo "stub should not be called" >&2; exit 99`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-5",
      cwd: process.cwd(),
      user_prompt: "ignore `https://github.com/me/proj/issues/1` it is a literal",
    });

    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("skips already-seen ids on a second invocation in the same session", async () => {
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

    const first = await runHook({
      session_id: "e2e-6",
      cwd: process.cwd(),
      user_prompt: "https://github.com/me/proj/issues/3",
    });
    assert.notEqual(first.stdout, "");

    const second = await runHook({
      session_id: "e2e-6",
      cwd: process.cwd(),
      user_prompt: "https://github.com/me/proj/issues/3 again",
    });
    assert.equal(second.stdout, "");
    assert.equal(second.stderr, "");
  });

  it("survives provider failures (fetch returns null) without breaking the prompt", async () => {
    await writeStub("gh", `exit 1`);

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-7",
      cwd: process.cwd(),
      user_prompt: "https://github.com/me/proj/issues/3",
    });

    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("enriches a bare GitHub repo URL via stubbed gh", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj")
    cat <<'JSON'
{"description":"demo","html_url":"https://github.com/me/proj","language":"Go","default_branch":"main","stargazers_count":1}
JSON
    ;;
  "api repos/me/proj/readme -H Accept: application/vnd.github.raw")
    echo "# Hello"
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-8",
      cwd: process.cwd(),
      user_prompt: "see https://github.com/me/proj",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: repo me\/proj/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Repo me\/proj: demo/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Language: Go/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /# Hello/);
  });

  it("enriches multiple providers in a single prompt", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/issues/3")
    echo '{"title":"Bug","state":"open","user":{"login":"alice"}}'
    ;;
  *)
    exit 1
    ;;
esac
`,
    );
    await writeStub(
      "acli",
      `
case "$*" in
  "jira workitem view PROJ-1 --json")
    echo '{"fields":{"summary":"Title"}}'
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-9",
      cwd: process.cwd(),
      user_prompt: "fix PROJ-1 (see https://github.com/me/proj/issues/3)",
    });

    assert.equal(code, 0);
    assert.match(stderr, /Auto-enriched: .*gh me\/proj#3.*jira PROJ-1|Auto-enriched: .*jira PROJ-1.*gh me\/proj#3/);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Issue me\/proj#3: Bug/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Jira PROJ-1: Title/);
  });

  it("skips a provider when disabled in config", async () => {
    await writeStub(
      "acli",
      `echo "should not be called" >&2; exit 99`,
    );
    await writeConfig(cacheDir, { providers: { jira: { enabled: false } } });

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-cfg-1",
      cwd: process.cwd(),
      user_prompt: "blocked by PROJ-1",
    });

    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("still runs other providers when one is disabled", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/issues/3")
    echo '{"title":"Hi","state":"open","user":{"login":"a"}}'
    ;;
  *)
    exit 1
    ;;
esac
`,
    );
    await writeStub("acli", `echo "should not be called" >&2; exit 99`);
    await writeConfig(cacheDir, { providers: { jira: { enabled: false } } });

    const { stdout, code } = await runHook({
      session_id: "e2e-cfg-2",
      cwd: process.cwd(),
      user_prompt: "PROJ-1 and https://github.com/me/proj/issues/3",
    });

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.systemMessage, /gh me\/proj#3/);
    assert.doesNotMatch(parsed.systemMessage, /jira/);
  });

  it("does not starve fresh refs when seen-cache is full (cap applied after seen filter)", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/issues/"*)
    n=$(echo "$*" | sed -E 's/.*\\/([0-9]+)$/\\1/')
    printf '{"title":"i%s","state":"open","user":{"login":"a"}}' "$n"
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    // First run: enriches refs 1..8 (the cap), leaving 9 and 10 unseen.
    const seedPrompt = Array.from({ length: 10 }, (_, i) =>
      `https://github.com/me/proj/issues/${i + 1}`,
    ).join(" ");
    const first = await runHook({
      session_id: "e2e-10",
      cwd: process.cwd(),
      user_prompt: seedPrompt,
    });
    assert.notEqual(first.stdout, "");
    const firstParsed = JSON.parse(first.stdout);
    const firstSummaries = firstParsed.systemMessage;
    assert.equal((firstSummaries.match(/me\/proj#/g) || []).length, 8);

    // Second run: same prompt. The previously-enriched 8 are filtered out,
    // leaving only the 2 unseen refs to enrich. With the buggy ordering
    // (cap before filter) this test would assert nothing - the cap would
    // include all 10 first, then filter would drop everything.
    const second = await runHook({
      session_id: "e2e-10",
      cwd: process.cwd(),
      user_prompt: seedPrompt,
    });
    assert.notEqual(second.stdout, "");
    const secondParsed = JSON.parse(second.stdout);
    assert.equal((secondParsed.systemMessage.match(/me\/proj#/g) || []).length, 2);
  });
});
