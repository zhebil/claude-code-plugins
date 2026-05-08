import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";
import { pickFirstString } from "../lib/text.mjs";
import { descriptionToMarkdown } from "../lib/adf.mjs";

const URL_PATTERN = /https?:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/g;
const KEY_PATTERN = /(?<![\w-])([A-Z][A-Z0-9]+-\d+)(?![\w-])/g;

const DEFAULT_BACKEND = "acli";

/**
 * @typedef {Object} JiraMatch
 * @property {string} id Stable id like `jira:PROJ-123`.
 * @property {string} key Issue key.
 */

/**
 * @typedef {Object} JiraNormalizedIssue
 * Canonical shape consumed by {@link formatJiraIssue}. Backends MUST
 * convert their CLI's output to this shape so the formatter stays
 * CLI-agnostic.
 *
 * @property {string} [url]
 * @property {Object} fields
 * @property {string} [fields.summary]
 * @property {string|Object} [fields.description] Plain string or ADF.
 * @property {{name: string}|string} [fields.status]
 * @property {{name: string}|string} [fields.issuetype]
 * @property {{name: string}|string} [fields.priority]
 * @property {{displayName: string}|string} [fields.assignee]
 * @property {{displayName: string}|string} [fields.reporter]
 */

/**
 * @typedef {Object} JiraBackend
 * @property {(key: string, ctx: import("./index.mjs").EnrichmentContext) => Promise<JiraNormalizedIssue|null>} fetch
 *   Run the CLI and return a normalized issue, or `null` on any failure
 *   (CLI not installed, auth missing, 404, parse error). The acli backend
 *   passes the raw response through (it already matches
 *   {@link JiraNormalizedIssue} closely enough for the formatter), while
 *   jira-cli normalizes via {@link normalizeJiraCli} to bridge schema
 *   differences (e.g. `issueType` vs `issuetype`).
 * @property {(key: string) => string} refetchHint
 *   Shell command the user can run to refetch with comments. Rendered
 *   verbatim into the markdown footer so the suggestion matches the
 *   CLI the user actually has installed.
 */

/**
 * Backends per CLI. Selection is driven by `ctx.providerConfig("jira").cli`.
 *
 * `acli` (Atlassian CLI) is the default and emits issues in standard
 * Jira REST shape (`{ url, fields: {...} }`) so its `fetch` is a thin
 * passthrough. `jira-cli` (ankitpokhrel/jira-cli) goes through
 * `jira issue list --jql "key = X" --raw`, returns an array, and uses
 * camelCase `issueType` instead of REST's `issuetype` - the normalizer
 * unwraps both.
 *
 * @type {Object<string, JiraBackend>}
 */
const backends = {
  acli: {
    async fetch(key, ctx) {
      const resp = await ctx.runner(
        "acli",
        ["jira", "workitem", "view", key, "--json"],
        { cwd: ctx.cwd },
      );
      if (resp.code !== 0) return null;
      const data = safeJsonParse(resp.stdout);
      if (!data || typeof data !== "object") return null;
      return data;
    },
    refetchHint(key) {
      return `acli jira workitem view ${key} --comments`;
    },
  },

  "jira-cli": {
    async fetch(key, ctx) {
      const resp = await ctx.runner(
        "jira",
        ["issue", "list", "--jql", `key = ${key}`, "--raw", "--paginate", "0:1"],
        { cwd: ctx.cwd },
      );
      if (resp.code !== 0) return null;
      const data = safeJsonParse(resp.stdout);
      const first = Array.isArray(data) ? data[0] : null;
      if (!first || typeof first !== "object") return null;
      return normalizeJiraCli(first);
    },
    refetchHint(key) {
      return `jira issue view ${key} --comments 10`;
    },
  },
};

/**
 * jira-cli emits `fields.issueType` (camelCase). Standard Jira REST
 * (and acli) use `fields.issuetype` (lowercase). Mirror it so
 * {@link formatJiraIssue} can read either.
 *
 * @param {Object} issue Raw `Issue` object from `jira issue list --raw`.
 * @returns {JiraNormalizedIssue}
 */
function normalizeJiraCli(issue) {
  const fields = { ...(issue.fields ?? {}) };
  if (fields.issueType && !fields.issuetype) {
    fields.issuetype = fields.issueType;
  }
  return { ...issue, fields };
}

/**
 * Provider that enriches Jira issue references via a swappable CLI
 * backend (`acli` by default, `jira-cli` opt-in via config).
 *
 * Recognized reference shapes:
 *   - URL:  https://yourorg.atlassian.net/browse/PROJ-123
 *   - Key:  PROJ-123  (any uppercase project prefix + dash + number)
 *
 * References inside backticks are skipped so users can paste a key as
 * literal text without triggering a fetch.
 */
export const jiraProvider = {
  name: "jira",

  /**
   * Find every Jira key or browse URL in `text`, excluding code spans.
   *
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx]
   * @returns {JiraMatch[]}
   */
  detect(text, codeRanges, _ctx) {
    const matches = [];
    const seen = new Set();
    const push = (key) => {
      const id = `jira:${key}`;
      if (seen.has(id)) return;
      seen.add(id);
      matches.push({ id, key });
    };
    for (const m of text.matchAll(URL_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      push(m[1]);
    }
    for (const m of text.matchAll(KEY_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      push(m[1]);
    }
    return matches;
  },

  /**
   * @param {JiraMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const cliName = pickBackendName(ctx);
    const backend = backends[cliName];
    const issue = await backend.fetch(match.key, ctx);
    if (!issue) return null;
    return formatJiraIssue(match.key, issue, backend.refetchHint(match.key));
  },

  /**
   * @param {JiraMatch} match
   * @returns {string}
   */
  summarize(match) {
    return `jira ${match.key}`;
  },
};

/**
 * Resolve which backend to use. Defaults to `acli` and falls back when
 * an unknown name appears in config so a typo doesn't silently disable
 * the provider.
 *
 * @param {import("./index.mjs").EnrichmentContext} ctx
 * @returns {keyof typeof backends}
 */
function pickBackendName(ctx) {
  const requested = ctx.providerConfig?.("jira")?.cli;
  if (typeof requested !== "string" || !requested) return DEFAULT_BACKEND;
  if (!backends[requested]) {
    process.stderr.write(
      `auto-enrich: unknown jira cli "${requested}"; falling back to ${DEFAULT_BACKEND}\n`,
    );
    return DEFAULT_BACKEND;
  }
  return requested;
}

/**
 * Render the markdown block from a normalized issue. Tolerates both
 * `{fields: {...}}` and flat shapes acli sometimes returns.
 *
 * @param {string} key
 * @param {JiraNormalizedIssue} raw
 * @param {string} refetchHint Shell command rendered into the footer.
 * @returns {string}
 */
function formatJiraIssue(key, raw, refetchHint) {
  const fields = raw.fields ?? raw;
  const summary = pickFirstString(fields.summary, raw.summary);
  const status = pickFirstString(fields.status, raw.status);
  const type = pickFirstString(fields.issuetype, fields.type, raw.type);
  const priority = pickFirstString(fields.priority, raw.priority);
  const assignee = pickFirstString(fields.assignee, raw.assignee) || "unassigned";
  const reporter = pickFirstString(fields.reporter, raw.reporter);
  const description = descriptionToMarkdown(fields.description ?? raw.description);
  const url = raw.url ?? raw.self ?? "";

  const lines = [];
  lines.push(`#### Jira ${key}: ${summary}`);
  if (url) lines.push(`- URL: ${url}`);
  if (type) lines.push(`- Type: ${type}`);
  if (status) lines.push(`- Status: ${status}`);
  if (priority) lines.push(`- Priority: ${priority}`);
  lines.push(`- Assignee: ${assignee}`);
  if (reporter) lines.push(`- Reporter: ${reporter}`);
  if (description) lines.push("", "**Description:**", description);
  lines.push("", `Refetch with comments: \`${refetchHint}\``);
  return lines.join("\n");
}
