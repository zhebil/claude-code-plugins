import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function writeConfig(dir, payload) {
  await writeFile(join(dir, "config.json"), JSON.stringify(payload));
}

async function writeProjectConfig(projectRoot, payload) {
  await mkdir(join(projectRoot, ".claude"), { recursive: true });
  await writeFile(join(projectRoot, ".claude", "auto-enrich.json"), JSON.stringify(payload));
}

async function writeManifest(dir, paths) {
  await writeFile(
    join(dir, "discovery.json"),
    JSON.stringify({ loadedAt: Date.now(), paths }, null, 2),
  );
}

async function writeManifestEntries(dir, entries) {
  await writeFile(
    join(dir, "discovery.json"),
    JSON.stringify(
      { loadedAt: Date.now(), entries, paths: entries.map((e) => e.path) },
      null,
      2,
    ),
  );
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

  it("enriches a GitHub file URL via stubbed gh", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/contents/src/x.py"*)
    cat <<'PY'
def hello():
    return "world"

def goodbye():
    return "bye"
PY
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-file-1",
      cwd: process.cwd(),
      user_prompt: "look at https://github.com/me/proj/blob/main/src/x.py#L1-L2",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: file me\/proj:src\/x\.py#L1-L2/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /File me\/proj@main - src\/x\.py - lines 1-2/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /1: def hello\(\):/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /2:     return "world"/);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /3: /);
  });

  it("does NOT enrich a /blob/ URL as a repo (no README dump)", async () => {
    await writeStub(
      "gh",
      `
case "$*" in
  "api repos/me/proj/contents/missing.py"*)
    exit 1
    ;;
  "api repos/me/proj")
    echo "should not be called for a /blob/ URL" >&2
    exit 99
    ;;
  "api repos/me/proj/readme"*)
    echo "should not be called for a /blob/ URL" >&2
    exit 99
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-file-2",
      cwd: process.cwd(),
      user_prompt: "see https://github.com/me/proj/blob/main/missing.py",
    });

    assert.equal(code, 0);
    // Fetch failed for the file; the repo provider must not have run, so
    // no enrichment is emitted at all.
    assert.equal(stdout, "");
    assert.equal(stderr, "");
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

  it("uses jira-cli backend when configured", async () => {
    await writeStub("acli", `echo "should not be called" >&2; exit 99`);
    await writeStub(
      "jira",
      `
case "$*" in
  "issue list --jql key = PROJ-1 --raw --paginate 0:1")
    cat <<'JSON'
[{"key":"PROJ-1","fields":{"summary":"Title","issueType":{"name":"Bug"},"status":{"name":"Open"},"assignee":{"displayName":"Alice"}}}]
JSON
    ;;
  *)
    exit 1
    ;;
esac
`,
    );
    await writeConfig(cacheDir, { providers: { jira: { cli: "jira-cli" } } });

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-jira-cli",
      cwd: process.cwd(),
      user_prompt: "look at PROJ-1",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: jira PROJ-1/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Jira PROJ-1: Title/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Type: Bug/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /jira issue view PROJ-1 --comments 10/);
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

  it("loads a custom provider listed in the discovery manifest", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-custom-"));
    const providerPath = join(customDir, "linear.provider.mjs");
    await writeFile(
      providerPath,
      `
        const PATTERN = /\\b(LIN-\\d+)\\b/g;
        export default {
          apiVersion: 1,
          name: "linear",
          detect(text, codeRanges) {
            const out = [];
            for (const m of text.matchAll(PATTERN)) {
              out.push({ id: "linear:" + m[1], key: m[1] });
            }
            return out;
          },
          async fetch(match) {
            return "#### Linear " + match.key + ": Custom provider works";
          },
          summarize(match) {
            return "linear " + match.key;
          },
        };
      `,
    );
    await writeManifest(cacheDir, [providerPath]);

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-custom-1",
      cwd: process.cwd(),
      user_prompt: "fix LIN-42",
    });

    await rm(customDir, { recursive: true, force: true });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: linear LIN-42/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Linear LIN-42: Custom provider works/);
  });

  it("ignores a manifest entry that fails the runtime contract check", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-broken-"));
    const providerPath = join(customDir, "broken.provider.mjs");
    await writeFile(
      providerPath,
      `export default { apiVersion: 1, name: "broken", detect: () => [] };`,
    );
    await writeManifest(cacheDir, [providerPath]);

    const { stdout, code } = await runHook({
      session_id: "e2e-custom-2",
      cwd: process.cwd(),
      user_prompt: "no refs here",
    });

    await rm(customDir, { recursive: true, force: true });

    assert.equal(code, 0);
    assert.equal(stdout, "");
  });

  it("loads a project-source provider when the cwd is on the trust list", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-trusted-"));
    const providerPath = join(projectDir, "team.provider.mjs");
    await writeFile(
      providerPath,
      `
        const PATTERN = /\\b(TEAM-\\d+)\\b/g;
        export default {
          apiVersion: 1,
          name: "team",
          detect(text) {
            const out = [];
            for (const m of text.matchAll(PATTERN)) {
              out.push({ id: "team:" + m[1], key: m[1] });
            }
            return out;
          },
          async fetch(match) {
            return "#### Team " + match.key + ": project-trusted";
          },
          summarize(match) { return "team " + match.key; },
        };
      `,
    );
    await writeManifestEntries(cacheDir, [{ path: providerPath, source: "project" }]);
    await writeConfig(cacheDir, { trustedProjects: [projectDir] });

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-trusted-1",
      cwd: projectDir,
      user_prompt: "fix TEAM-7",
    });

    await rm(projectDir, { recursive: true, force: true });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: team TEAM-7/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Team TEAM-7: project-trusted/);
  });

  it("ignores a project-source provider when the cwd is NOT trusted", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-untrusted-"));
    const providerPath = join(projectDir, "team.provider.mjs");
    await writeFile(
      providerPath,
      `
        const PATTERN = /\\b(TEAM-\\d+)\\b/g;
        export default {
          apiVersion: 1,
          name: "team",
          detect(text) {
            const out = [];
            for (const m of text.matchAll(PATTERN)) {
              out.push({ id: "team:" + m[1], key: m[1] });
            }
            return out;
          },
          async fetch() { return "#### should not run"; },
          summarize() { return "team"; },
        };
      `,
    );
    await writeManifestEntries(cacheDir, [{ path: providerPath, source: "project" }]);
    // No trustedProjects in config; cwd is the project dir but not opted in.

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-untrusted-1",
      cwd: projectDir,
      user_prompt: "fix TEAM-7",
    });

    await rm(projectDir, { recursive: true, force: true });

    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("project-local config disables a globally-enabled provider", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-projcfg-"));
    await writeStub("acli", `echo "should not be called" >&2; exit 99`);
    // Global config: jira explicitly enabled.
    await writeConfig(cacheDir, { providers: { jira: { enabled: true } } });
    // Project config: jira disabled. Project should win.
    await writeProjectConfig(projectDir, { providers: { jira: { enabled: false } } });

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-projcfg-1",
      cwd: projectDir,
      user_prompt: "blocked by PROJ-1",
    });

    await rm(projectDir, { recursive: true, force: true });

    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("project-local config can switch jira backend without disabling", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-projcli-"));
    await writeStub("acli", `echo "should not be called" >&2; exit 99`);
    await writeStub(
      "jira",
      `
case "$*" in
  "issue list --jql key = PROJ-1 --raw --paginate 0:1")
    cat <<'JSON'
[{"key":"PROJ-1","fields":{"summary":"Title","issueType":{"name":"Bug"},"status":{"name":"Open"},"assignee":{"displayName":"Alice"}}}]
JSON
    ;;
  *)
    exit 1
    ;;
esac
`,
    );
    // Global says acli; project flips to jira-cli.
    await writeConfig(cacheDir, { providers: { jira: { enabled: true, cli: "acli" } } });
    await writeProjectConfig(projectDir, { providers: { jira: { cli: "jira-cli" } } });

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-projcli-1",
      cwd: projectDir,
      user_prompt: "look at PROJ-1",
    });

    await rm(projectDir, { recursive: true, force: true });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: jira PROJ-1/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Jira PROJ-1: Title/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Type: Bug/);
  });

  it("project-local config CANNOT grant trust to itself (trustedProjects ignored)", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "auto-enrich-e2e-projtrust-"));
    const providerPath = join(projectDir, "team.provider.mjs");
    await writeFile(
      providerPath,
      `
        const PATTERN = /\\b(TEAM-\\d+)\\b/g;
        export default {
          apiVersion: 1,
          name: "team",
          detect(text) {
            const out = [];
            for (const m of text.matchAll(PATTERN)) {
              out.push({ id: "team:" + m[1], key: m[1] });
            }
            return out;
          },
          async fetch() { return "#### should not run"; },
          summarize() { return "team"; },
        };
      `,
    );
    // Project is on the manifest as a project-source provider.
    await writeManifestEntries(cacheDir, [{ path: providerPath, source: "project" }]);
    // The project tries to trust itself - this MUST be ignored.
    await writeProjectConfig(projectDir, { trustedProjects: [projectDir] });
    // No trustedProjects in the global config.

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-projtrust-1",
      cwd: projectDir,
      user_prompt: "fix TEAM-7",
    });

    await rm(projectDir, { recursive: true, force: true });

    assert.equal(code, 0);
    assert.equal(stdout, "");
    // Stderr should contain a single warning that trustedProjects in project config was ignored.
    assert.match(stderr, /trustedProjects/);
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

  it("enriches a GitLab issue URL via stubbed glab", async () => {
    await writeStub(
      "glab",
      `
case "$*" in
  "api projects/group%2Fproj/issues/3")
    cat <<'JSON'
{"title":"Bug","state":"opened","web_url":"https://gitlab.com/group/proj/-/issues/3","author":{"username":"alice"},"description":"issue body","labels":["bug"]}
JSON
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-gitlab-1",
      cwd: process.cwd(),
      user_prompt: "look at https://gitlab.com/group/proj/-/issues/3",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: glab group\/proj#3/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Issue group\/proj#3: Bug/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Author: alice/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Labels: bug/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /issue body/);
  });

  it("enriches a GitLab merge request URL via stubbed glab", async () => {
    await writeStub(
      "glab",
      `
case "$*" in
  "api projects/group%2Fproj/merge_requests/9")
    cat <<'JSON'
{"title":"Add feature","state":"opened","web_url":"https://gitlab.com/group/proj/-/merge_requests/9","author":{"username":"alice"},"source_branch":"feat/x","target_branch":"main","draft":false,"merge_status":"can_be_merged","detailed_merge_status":"mergeable","description":"MR body"}
JSON
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-gitlab-2",
      cwd: process.cwd(),
      user_prompt: "review https://gitlab.com/group/proj/-/merge_requests/9",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: glab group\/proj!9/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /MR group\/proj!9: Add feature/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Branch: feat\/x -> main/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Detailed status: mergeable/);
  });

  it("enriches a GitLab project URL with metadata + README via stubbed glab", async () => {
    await writeStub(
      "glab",
      `
case "$*" in
  "api projects/me%2Fproj")
    cat <<'JSON'
{"description":"demo","web_url":"https://gitlab.com/me/proj","default_branch":"main","visibility":"public","star_count":3,"readme_url":"https://gitlab.com/me/proj/-/blob/main/README.md"}
JSON
    ;;
  "api projects/me%2Fproj/repository/files/README.md/raw?ref=main")
    echo "# Hello"
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-gitlab-3",
      cwd: process.cwd(),
      user_prompt: "see https://gitlab.com/me/proj",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: glab-repo me\/proj/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Project me\/proj: demo/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Default branch: main/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /- Visibility: public/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /# Hello/);
  });

  it("enriches a GitLab file URL with a line anchor via stubbed glab", async () => {
    await writeStub(
      "glab",
      `
case "$*" in
  "api projects/me%2Fproj/repository/files/src%2Fx.py/raw?ref=main")
    cat <<'PY'
def hello():
    return "world"

def goodbye():
    return "bye"
PY
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, stderr, code } = await runHook({
      session_id: "e2e-gitlab-4",
      cwd: process.cwd(),
      user_prompt: "look at https://gitlab.com/me/proj/-/blob/main/src/x.py#L1-2",
    });

    assert.equal(code, 0);
    assert.match(stderr, /^Auto-enriched: glab-file me\/proj:src\/x\.py#L1-L2/m);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /File me\/proj@main - src\/x\.py - lines 1-2/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /1: def hello\(\):/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /2:     return "world"/);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /3: /);
  });

  it("does NOT match a GitLab sub-resource URL as a project (no project block)", async () => {
    // Issue stub succeeds so we get enrichment; the project endpoint must
    // never be called - asserting on stdout/stderr alone is tautological
    // because a silent failure looks the same as a correct skip.
    await writeStub(
      "glab",
      `
case "$*" in
  "api projects/me%2Fproj/issues/3")
    cat <<'JSON'
{"title":"Hi","state":"opened","web_url":"https://gitlab.com/me/proj/-/issues/3","author":{"username":"a"}}
JSON
    ;;
  "api projects/me%2Fproj")
    echo "should not be called for a sub-resource URL" >&2
    exit 99
    ;;
  *)
    exit 1
    ;;
esac
`,
    );

    const { stdout, code } = await runHook({
      session_id: "e2e-gitlab-5",
      cwd: process.cwd(),
      user_prompt: "see https://gitlab.com/me/proj/-/issues/3",
    });

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    // Issue enrichment is present; project enrichment is NOT.
    assert.match(parsed.systemMessage, /glab me\/proj#3/);
    assert.doesNotMatch(parsed.systemMessage, /glab-repo/);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /Project me\/proj/);
  });
});
