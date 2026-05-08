import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";

const MAX_README_CHARS = 12000;

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
   * Find every plain repo URL in `text`, excluding code spans and reserved
   * sub-paths (issues/pull/actions/etc.).
   *
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx] Unused; kept for
   *   contract compatibility with other providers.
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
   * @param {{cwd: string, runner: Function}} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const { owner, repo } = match;
    const metaResp = await ctx.runner("gh", ["api", `repos/${owner}/${repo}`], { cwd: ctx.cwd });
    const meta = metaResp.code === 0 ? safeJsonParse(metaResp.stdout) : null;
    const readmeResp = await ctx.runner(
      "gh",
      ["api", `repos/${owner}/${repo}/readme`, "-H", "Accept: application/vnd.github.raw"],
      { cwd: ctx.cwd },
    );
    const readme = readmeResp.code === 0 ? readmeResp.stdout : "";
    if (!meta && !readme.trim()) return null;
    return formatRepo({ owner, repo, meta, readme });
  },

  /**
   * @param {GithubRepoMatch} match
   * @returns {string}
   */
  summarize(match) {
    return `repo ${match.owner}/${match.repo}`;
  },
};

/**
 * Render the markdown block. Pure function.
 *
 * @param {Object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {Object|null} args.meta `gh api repos/owner/repo` response.
 * @param {string} args.readme Raw README text (may be empty).
 * @returns {string}
 */
function formatRepo({ owner, repo, meta, readme }) {
  const lines = [];
  const desc = meta?.description ? `: ${meta.description}` : "";
  lines.push(`#### Repo ${owner}/${repo}${desc}`);
  if (meta?.html_url) lines.push(`- URL: ${meta.html_url}`);
  if (meta?.language) lines.push(`- Language: ${meta.language}`);
  if (meta?.default_branch) lines.push(`- Default branch: ${meta.default_branch}`);
  if (meta?.stargazers_count != null) lines.push(`- Stars: ${meta.stargazers_count}`);
  if (meta?.archived) lines.push("- Archived: yes");
  if (meta?.fork) lines.push("- Fork: yes");
  if (meta?.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION") {
    lines.push(`- License: ${meta.license.spdx_id}`);
  }

  const trimmed = readme.trim();
  if (trimmed) {
    const body = trimmed.length > MAX_README_CHARS
      ? `${trimmed.slice(0, MAX_README_CHARS)}\n\n...(README truncated, ${trimmed.length - MAX_README_CHARS} more chars)`
      : trimmed;
    lines.push("", "**README:**", body);
  }

  lines.push(
    "",
    `Refetch full README: \`gh api repos/${owner}/${repo}/readme -H "Accept: application/vnd.github.raw"\``,
  );
  return lines.join("\n");
}
