import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";
import { renderEntity, truncateReadme } from "../lib/render-entity.mjs";

// Repo name regex allows dots only between word chars, so trailing
// punctuation (period, question mark, exclamation) at the end of a sentence
// is left out: `https://github.com/foo/bar.` matches `bar`, but
// `https://github.com/vuejs/vue.js` still matches `vue.js`.
// The inner `(?!git\b)` excludes `.git` from the dotted-name run so the
// explicit `.git` suffix capture below still works.
const REPO_URL_PATTERN =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w-]+(?:\.(?!git\b)[\w-]+)*)(?:\.git)?(?:\/(\w+)[\w./-]*)?(?=[\s)\]>,.!?]|$)/g;

const RESERVED_REPO_SUBPATHS = new Set([
  "pull", "issues", "pulls", "actions", "discussions", "releases",
  "wiki", "settings", "security", "network", "pulse", "graphs", "compare",
  "blob", "raw", "tree", "blame", "commit", "commits",
]);

/**
 * @typedef {Object} GithubRepoMatch
 * @property {string} id Stable id like `github-repo:owner/repo`.
 * @property {string} owner
 * @property {string} repo
 */

/**
 * Provider that enriches plain GitHub repository URLs (no issue/PR/path
 * suffix). Emits a markdown block with metadata and a truncated README.
 *
 * URLs that point at a sub-resource (`/pull/N`, `/issues/N`, `/actions`,
 * etc.) are intentionally skipped so the github-issue provider or the
 * user's own intent isn't shadowed by a noisy repo dump.
 *
 * References inside backticks are skipped.
 */
export const githubRepoProvider = {
  name: "github-repo",

  /**
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx]
   * @returns {GithubRepoMatch[]}
   */
  detect(text, codeRanges, _ctx) {
    const matches = [];
    const seen = new Set();
    for (const m of text.matchAll(REPO_URL_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      const [, owner, repo, subpath] = m;
      if (subpath && RESERVED_REPO_SUBPATHS.has(subpath)) continue;
      const id = `github-repo:${owner}/${repo}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({ id, owner, repo });
    }
    return matches;
  },

  /**
   * Fetch repo metadata and the raw README. Either may be missing; only
   * returns `null` when both lookups fail.
   *
   * @param {GithubRepoMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const { owner, repo } = match;
    const metaResp = await ctx.runner("gh", ["api", `repos/${owner}/${repo}`], { cwd: ctx.cwd });
    const meta = metaResp.code === 0 ? safeJsonParse(metaResp.stdout) : null;
    if (ctx.budgetExceeded?.()) return null;
    const readmeResp = await ctx.runner(
      "gh",
      ["api", `repos/${owner}/${repo}/readme`, "-H", "Accept: application/vnd.github.raw"],
      { cwd: ctx.cwd },
    );
    const readme = readmeResp.code === 0 ? readmeResp.stdout : "";
    if (!meta && !readme.trim()) return null;
    return formatRepo({ owner, repo, meta, readme });
  },

  summarize(match) {
    return `repo ${match.owner}/${match.repo}`;
  },
};

/**
 * @param {Object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {Object|null} args.meta
 * @param {string} args.readme
 * @returns {string}
 */
function formatRepo({ owner, repo, meta, readme }) {
  const desc = meta?.description ? `: ${meta.description}` : "";
  const license = meta?.license?.spdx_id;

  const bullets = [
    ["URL", meta?.html_url],
    ["Language", meta?.language],
    ["Default branch", meta?.default_branch],
    meta?.stargazers_count != null ? ["Stars", meta.stargazers_count] : null,
    meta?.archived ? ["Archived", "yes"] : null,
    meta?.fork ? ["Fork", "yes"] : null,
    license && license !== "NOASSERTION" ? ["License", license] : null,
  ];

  const readmeText = truncateReadme(readme);
  const body = readmeText ? { title: "README", text: readmeText } : null;

  return renderEntity({
    heading: `Repo ${owner}/${repo}${desc}`,
    bullets,
    body,
    refetch: `Refetch full README: \`gh api repos/${owner}/${repo}/readme -H "Accept: application/vnd.github.raw"\``,
  });
}
