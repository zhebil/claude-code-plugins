import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";
import { renderEntity, truncateReadme } from "../lib/render-entity.mjs";

// Matches at least two path segments; subgroups make the leading run
// repeatable. `[\w.-]+` admits a literal `-` segment, so `/-/` (GitLab's
// sub-resource separator) leaks in here and is filtered out in detect().
const REPO_URL_PATTERN =
  /https?:\/\/gitlab\.com\/((?:[\w.-]+\/)+[\w.-]+?)(?:\.git)?\/?(?=[\s)\]>,.!?]|$)/g;

/**
 * Top-level paths that look like `gitlab.com/<x>` but never resolve to a
 * project. Skipping these avoids a wasted API round-trip and a noisy 404.
 * Subgroup roots (e.g. `gitlab-org/`) are NOT in here - a URL like
 * `https://gitlab.com/gitlab-org/gitlab` is a real project under a group.
 */
const RESERVED_TOP_LEVEL = new Set([
  "users", "groups", "explore", "help", "dashboard", "admin",
  "search", "snippets", "public", "projects", "-",
]);

/**
 * @typedef {Object} GitlabRepoMatch
 * @property {string} id Stable id like `gitlab-repo:group/project`.
 * @property {string} fullPath e.g. `gitlab-org/gitlab` or `group/sub/proj`.
 */

/**
 * Provider that enriches plain GitLab project URLs (no `/-/...` suffix).
 * Emits metadata plus a truncated README when one is published.
 *
 * URLs that point at a sub-resource (`/-/issues/N`, `/-/blob/...`, etc.)
 * are intentionally skipped here so the gitlab-issue or gitlab-file
 * providers can claim them.
 */
export const gitlabRepoProvider = {
  name: "gitlab-repo",

  /**
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx]
   * @returns {GitlabRepoMatch[]}
   */
  detect(text, codeRanges, _ctx) {
    const matches = [];
    const seen = new Set();
    for (const m of text.matchAll(REPO_URL_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      const fullPath = m[1];
      // GitLab uses /-/ to separate the project path from sub-resources.
      // Anything containing /-/ here is a sub-resource URL belonging to
      // another provider (gitlab-issue, gitlab-file, etc.).
      if (fullPath.includes("/-/")) continue;
      const firstSegment = fullPath.split("/", 1)[0];
      if (RESERVED_TOP_LEVEL.has(firstSegment)) continue;
      const id = `gitlab-repo:${fullPath}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({ id, fullPath });
    }
    return matches;
  },

  /**
   * Fetch project metadata, then (best-effort) the README at the path
   * advertised by `readme_url`. Returns `null` when the metadata call fails
   * - we don't want to render a header with no body.
   *
   * @param {GitlabRepoMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const { fullPath } = match;
    const encoded = encodeURIComponent(fullPath);
    const metaResp = await ctx.runner("glab", ["api", `projects/${encoded}`], { cwd: ctx.cwd });
    if (metaResp.code !== 0) return null;
    const meta = safeJsonParse(metaResp.stdout);
    if (!meta || typeof meta !== "object") return null;

    let readme = "";
    const readmeInfo = parseReadmeFromUrl(meta.readme_url);
    if (readmeInfo && !ctx.budgetExceeded?.()) {
      const fileResp = await ctx.runner(
        "glab",
        [
          "api",
          `projects/${encoded}/repository/files/${encodeURIComponent(readmeInfo.path)}/raw?ref=${encodeURIComponent(readmeInfo.ref)}`,
        ],
        { cwd: ctx.cwd },
      );
      if (fileResp.code === 0) readme = fileResp.stdout;
    }
    return formatRepo({ fullPath, meta, readme });
  },

  summarize(match) {
    return `glab-repo ${match.fullPath}`;
  },
};

/**
 * GitLab's project metadata exposes `readme_url`, a fully-qualified
 * `.../-/blob/<ref>/<path>` URL. Pull the ref and path out so we can
 * fetch the raw bytes via the repository-files API. Returns `null` when
 * the project has no published README.
 *
 * @param {string|null|undefined} readmeUrl
 * @returns {{ref: string, path: string}|null}
 */
function parseReadmeFromUrl(readmeUrl) {
  if (!readmeUrl || typeof readmeUrl !== "string") return null;
  const m = /\/-\/blob\/([^/]+)\/(.+?)(?:[?#]|$)/.exec(readmeUrl);
  if (!m) return null;
  return { ref: m[1], path: m[2] };
}

/**
 * @param {Object} args
 * @param {string} args.fullPath
 * @param {Object} args.meta
 * @param {string} args.readme
 * @returns {string}
 */
function formatRepo({ fullPath, meta, readme }) {
  const desc = meta.description ? `: ${meta.description}` : "";

  const bullets = [
    ["URL", meta.web_url],
    ["Default branch", meta.default_branch],
    ["Visibility", meta.visibility],
    meta.star_count != null ? ["Stars", meta.star_count] : null,
    meta.archived ? ["Archived", "yes"] : null,
    meta.license?.key ? ["License", meta.license.key] : null,
  ];

  const readmeText = truncateReadme(readme);
  const body = readmeText ? { title: "README", text: readmeText } : null;

  const encoded = encodeURIComponent(fullPath);
  return renderEntity({
    heading: `Project ${fullPath}${desc}`,
    bullets,
    body,
    refetch: `Refetch: \`glab api projects/${encoded}\``,
  });
}
