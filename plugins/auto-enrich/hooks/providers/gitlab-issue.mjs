import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";
import { renderEntity } from "../lib/render-entity.mjs";

const URL_PATTERN =
  /https?:\/\/gitlab\.com\/((?:[\w.-]+\/)+[\w.-]+?)\/-\/(issues|merge_requests)\/(\d+)/g;

/**
 * @typedef {Object} GitlabIssueMatch
 * @property {string} id Stable id like `gitlab:group/proj#3` (issue) or
 *   `gitlab:group/proj!9` (MR).
 * @property {string} fullPath URL-encodable project path (e.g. `group/sub/proj`).
 * @property {string} iid Issue or MR internal id, as a string.
 * @property {boolean} isMr True for merge requests, false for issues.
 */

/**
 * Provider that enriches GitLab issue and merge request URLs via `glab`.
 *
 * Recognized URL shapes (gitlab.com only - self-hosted is not auto-detected):
 *   - https://gitlab.com/<namespace>/<project>/-/issues/<iid>
 *   - https://gitlab.com/<namespace>/<project>/-/merge_requests/<iid>
 *
 * Subgroups are supported - the namespace can be any number of segments.
 *
 * No bare-ref form is recognized: GitLab's `#1` / `!1` shorthands collide
 * with the github-issue provider's `#N` form, and a bare integer shorthand
 * has too many false positives in prose.
 *
 * References inside backticks are skipped via `isInsideCode`.
 */
export const gitlabIssueProvider = {
  name: "gitlab-issue",

  /**
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx]
   * @returns {GitlabIssueMatch[]}
   */
  detect(text, codeRanges, _ctx) {
    const matches = [];
    const seen = new Set();
    for (const m of text.matchAll(URL_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      const fullPath = m[1];
      const isMr = m[2] === "merge_requests";
      const iid = m[3];
      const sigil = isMr ? "!" : "#";
      const id = `gitlab:${fullPath}${sigil}${iid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({ id, fullPath, iid, isMr });
    }
    return matches;
  },

  /**
   * @param {GitlabIssueMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const { fullPath, iid, isMr } = match;
    const encoded = encodeURIComponent(fullPath);
    const endpoint = isMr
      ? `projects/${encoded}/merge_requests/${iid}`
      : `projects/${encoded}/issues/${iid}`;
    const resp = await ctx.runner("glab", ["api", endpoint], { cwd: ctx.cwd });
    if (resp.code !== 0) return null;
    const data = safeJsonParse(resp.stdout);
    if (!data || typeof data !== "object") return null;
    return formatIssueOrMr({ fullPath, iid, isMr, data });
  },

  summarize(match) {
    const sigil = match.isMr ? "!" : "#";
    return `glab ${match.fullPath}${sigil}${match.iid}`;
  },
};

/**
 * @param {Object} args
 * @param {string} args.fullPath
 * @param {string} args.iid
 * @param {boolean} args.isMr
 * @param {Object} args.data
 * @returns {string}
 */
function formatIssueOrMr({ fullPath, iid, isMr, data }) {
  const kind = isMr ? "MR" : "Issue";
  const sigil = isMr ? "!" : "#";
  const author = data.author?.username || data.author?.name;

  const bullets = [
    ["URL", data.web_url],
    ["State", data.state],
    author ? ["Author", author] : null,
    Array.isArray(data.labels) && data.labels.length
      ? ["Labels", data.labels.join(", ")]
      : null,
  ];

  if (isMr) {
    if (data.source_branch && data.target_branch) {
      bullets.push(["Branch", `${data.source_branch} -> ${data.target_branch}`]);
    }
    if (data.draft || data.work_in_progress) bullets.push(["Draft", "yes"]);
    if (data.merge_status) bullets.push(["Merge status", data.merge_status]);
    if (data.detailed_merge_status && data.detailed_merge_status !== data.merge_status) {
      bullets.push(["Detailed status", data.detailed_merge_status]);
    }
  }

  const body = String(data.description ?? "").trim()
    ? { title: "Description", text: data.description }
    : null;

  const refetchCmd = isMr
    ? `glab mr view ${iid} -R ${fullPath} --comments`
    : `glab issue view ${iid} -R ${fullPath} --comments`;

  return renderEntity({
    heading: `${kind} ${fullPath}${sigil}${iid}: ${data.title ?? ""}`,
    bullets,
    body,
    refetch: `Refetch with comments: \`${refetchCmd}\``,
  });
}
