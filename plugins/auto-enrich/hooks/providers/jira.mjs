import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";
import { pickFirstString } from "../lib/text.mjs";
import { descriptionToMarkdown } from "../lib/adf.mjs";

const URL_PATTERN = /https?:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/g;
const KEY_PATTERN = /(?<![\w-])([A-Z][A-Z0-9]+-\d+)(?![\w-])/g;

/**
 * @typedef {Object} JiraMatch
 * @property {string} id Stable id like `jira:PROJ-123`.
 * @property {string} key Issue key.
 */

/**
 * Provider that enriches Jira issue references via the Atlassian CLI.
 *
 * Recognized reference shapes:
 *   - URL:  https://yourorg.atlassian.net/browse/PROJ-123
 *   - Key:  PROJ-123  (any uppercase project prefix + dash + number)
 *
 * References inside backticks are skipped, so users can paste a key as
 * literal text without triggering a fetch.
 */
export const jiraProvider = {
  name: "jira",

  /**
   * Find every Jira key or browse URL in `text`, excluding code spans.
   *
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx] Unused; kept for
   *   contract compatibility with other providers.
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
   * @param {{cwd: string, runner: Function}} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const resp = await ctx.runner(
      "acli",
      ["jira", "workitem", "view", match.key, "--json"],
      { cwd: ctx.cwd },
    );
    if (resp.code !== 0) return null;
    const data = safeJsonParse(resp.stdout);
    if (!data) return null;
    return formatJiraIssue(match.key, data);
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
 * Render the markdown block. Tolerates two shapes Jira returns:
 * `{fields: {...}}` (REST v3) and a flat object (acli's flattened view).
 *
 * @param {string} key
 * @param {Object} raw Parsed acli/Jira response.
 * @returns {string}
 */
function formatJiraIssue(key, raw) {
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
  lines.push("", `Refetch with comments: \`acli jira workitem view ${key} --comments\``);
  return lines.join("\n");
}
