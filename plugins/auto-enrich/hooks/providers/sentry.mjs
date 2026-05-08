import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";
import { asText } from "../lib/text.mjs";

const URL_PATTERN = /https?:\/\/(?:[\w.-]+\.)?sentry\.io\/(?:organizations\/[\w.-]+\/)?issues\/(\d+)/g;

const INTERESTING_TAGS = new Set([
  "environment", "release", "transaction", "url",
  "browser", "browser.name", "os", "os.name",
  "runtime", "runtime.name", "server_name", "handled", "level",
]);

const STACK_FRAMES_TO_SHOW = 10;
const MAX_BLOB_CHARS = 12000;
const TRUNCATION_MARKER = "[…truncated]";

function clip(text) {
  const s = String(text ?? "");
  if (s.length <= MAX_BLOB_CHARS) return s;
  return `${s.slice(0, MAX_BLOB_CHARS)} ${TRUNCATION_MARKER}`;
}

/**
 * @typedef {Object} SentryMatch
 * @property {string} id Stable id like `sentry:7465194385`.
 * @property {string} issueId Numeric Sentry issue id.
 */

/**
 * Provider that enriches Sentry issue URLs via the Sentry CLI. Pulls both
 * the issue summary and the latest event so stack traces and tags are
 * available without a follow-up tool call.
 *
 * Recognized reference shapes:
 *   - https://sentry.io/issues/123/
 *   - https://yourorg.sentry.io/organizations/yourorg/issues/123/
 *
 * References inside backticks are skipped.
 */
export const sentryProvider = {
  name: "sentry",

  /**
   * Find every Sentry issue URL in `text`, excluding code spans.
   *
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx] Unused; kept for
   *   contract compatibility with other providers.
   * @returns {SentryMatch[]}
   */
  detect(text, codeRanges, _ctx) {
    const matches = [];
    const seen = new Set();
    for (const m of text.matchAll(URL_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      const issueId = m[1];
      const id = `sentry:${issueId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({ id, issueId });
    }
    return matches;
  },

  /**
   * Fetch the issue and its latest event. The issue lookup is required;
   * a missing latest event just means the formatted block has fewer
   * details (no stack trace / tags).
   *
   * @param {SentryMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const issueResp = await ctx.runner(
      "sentry",
      ["api", `/api/0/issues/${match.issueId}/`],
      { cwd: ctx.cwd },
    );
    if (issueResp.code !== 0) return null;
    const issue = safeJsonParse(issueResp.stdout);
    if (!issue) return null;

    if (ctx.budgetExceeded?.()) return null;
    const eventResp = await ctx.runner(
      "sentry",
      ["api", `/api/0/issues/${match.issueId}/events/latest/`],
      { cwd: ctx.cwd },
    );
    const event = eventResp.code === 0 ? safeJsonParse(eventResp.stdout) : null;
    return formatSentryIssue(match.issueId, issue, event);
  },

  /**
   * @param {SentryMatch} match
   * @returns {string}
   */
  summarize(match) {
    return `sentry ${match.issueId}`;
  },
};

/**
 * Render the markdown block. Pure function.
 *
 * @param {string} id
 * @param {Object} issue Parsed `/api/0/issues/{id}/` response.
 * @param {Object|null} event Parsed `/api/0/issues/{id}/events/latest/` response.
 * @returns {string}
 */
function formatSentryIssue(id, issue, event) {
  const lines = [];
  const title = issue.title ?? issue.metadata?.title ?? event?.title ?? "(no title)";
  lines.push(`#### Sentry issue ${id}: ${title}`);
  if (issue.permalink) lines.push(`- URL: ${issue.permalink}`);
  if (issue.shortId) lines.push(`- Short ID: ${issue.shortId}`);
  if (issue.project?.slug) lines.push(`- Project: ${issue.project.slug}`);
  if (issue.level) lines.push(`- Level: ${issue.level}`);
  if (issue.status) lines.push(`- Status: ${issue.status}`);
  if (issue.culprit) lines.push(`- Culprit: ${issue.culprit}`);
  if (issue.count != null) lines.push(`- Event count: ${issue.count}`);
  if (issue.userCount != null) lines.push(`- Users affected: ${issue.userCount}`);
  if (issue.firstSeen) lines.push(`- First seen: ${issue.firstSeen}`);
  if (issue.lastSeen) lines.push(`- Last seen: ${issue.lastSeen}`);
  const assignee =
    issue.assignedTo?.name ?? issue.assignedTo?.username ?? issue.assignedTo?.email;
  if (assignee) lines.push(`- Assignee: ${assignee}`);

  const topMessage = asText(issue.metadata?.value ?? issue.message);
  if (topMessage.trim()) lines.push("", "**Message:**", clip(topMessage.trim()));

  if (event) appendEventDetails(lines, event, topMessage);

  lines.push(
    "",
    `Refetch full latest event: \`sentry api /api/0/issues/${id}/events/latest/\`\nRefetch issue events: \`sentry api /api/0/issues/${id}/events/\``,
  );
  return lines.join("\n");
}

/**
 * Append tag list, exception summary or fallback message text from the
 * latest event onto the markdown buffer.
 *
 * @param {string[]} lines Buffer mutated in place.
 * @param {Object} event
 * @param {string} topMessage Issue-level message for de-duplication.
 */
function appendEventDetails(lines, event, topMessage) {
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const picked = tags.filter((tag) => INTERESTING_TAGS.has(tag.key));
  if (picked.length) {
    lines.push("", "**Tags:**");
    for (const tag of picked) lines.push(`- ${tag.key}: ${asText(tag.value)}`);
  }

  const entries = Array.isArray(event.entries) ? event.entries : [];
  const exception = entries.find((entry) => entry.type === "exception");
  const values = exception?.data?.values ?? [];
  if (values.length) {
    lines.push("", "**Exception:**");
    for (const value of values) {
      const head = value.module
        ? `${value.module}.${value.type ?? "Error"}`
        : value.type ?? "Error";
      const val = clip(asText(value.value));
      lines.push(`- ${head}${val ? `: ${val}` : ""}`);
      const frames = value.stacktrace?.frames ?? [];
      const top = frames.slice(-STACK_FRAMES_TO_SHOW).reverse();
      if (top.length) {
        lines.push("", "```");
        for (const frame of top) {
          const loc = `${frame.filename ?? frame.module ?? frame.absPath ?? "?"}:${frame.lineNo ?? "?"}`;
          const fn = frame.function ? ` in ${frame.function}` : "";
          const flag = frame.inApp === false ? " [vendor]" : "";
          lines.push(`  at ${loc}${fn}${flag}`);
        }
        lines.push("```");
      }
    }
  } else {
    const messageEntry = entries.find((entry) => entry.type === "message");
    const formatted = asText(messageEntry?.data?.formatted ?? messageEntry?.data?.message);
    if (formatted.trim() && formatted.trim() !== topMessage.trim()) {
      lines.push("", "**Event message:**", clip(formatted.trim()));
    }
  }

  if (event.eventID) lines.push("", `- Latest event ID: \`${event.eventID}\``);
}
