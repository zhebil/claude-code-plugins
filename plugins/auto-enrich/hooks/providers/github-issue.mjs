import { safeJsonParse } from "../lib/json.mjs";
import { isInsideCode } from "../lib/code-ranges.mjs";

const FULL_URL_PATTERN = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/g;
const SHORT_REF_PATTERN = /(?<![\w/-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const BARE_REF_PATTERN = /(?<![\w/#-])#(\d+)\b/g;
const BARE_REF_DETECTOR = /(?<![\w/#-])#\d+\b/;

const DEFAULT_REPO_TIMEOUT_MS = 5000;
const STATE_KEY = "github-issue";

/**
 * @typedef {Object} GithubIssueMatch
 * @property {string} id Stable id like `github:owner/repo#123`.
 * @property {string} owner GitHub owner (user or org).
 * @property {string} repo Repository name.
 * @property {string} number Issue or PR number, as a string.
 */

/**
 * Provider that enriches GitHub issue and pull request references. Emits a
 * markdown block with title, state, author, labels, body, and (for PRs)
 * branch/draft/review/checks summary.
 *
 * Recognized reference shapes:
 *   - Full URL:    https://github.com/owner/repo/pull/123
 *   - Full URL:    https://github.com/owner/repo/issues/45
 *   - Short ref:   owner/repo#123
 *   - Bare ref:    #123  (only when the cwd is a GitHub repo)
 *
 * References inside backticks (` ` or ``` blocks) are skipped via
 * {@link isInsideCode} - users can quote a token without triggering a fetch.
 */
export const githubIssueProvider = {
  name: STATE_KEY,

  /**
   * Resolve the cwd's GitHub repo (so bare `#123` refs can be expanded)
   * if the prompt actually contains a bare ref. Stashes the result under
   * `ctx.state["github-issue"].defaultRepo`. No-op when not needed.
   *
   * @param {string} text User prompt.
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<void>}
   */
  async prepare(text, ctx) {
    if (!BARE_REF_DETECTOR.test(text)) return;
    const r = await ctx.runner(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { cwd: ctx.cwd, timeout: DEFAULT_REPO_TIMEOUT_MS },
    );
    if (r.code !== 0) return;
    const defaultRepo = r.stdout.trim() || null;
    if (defaultRepo) ctx.state[STATE_KEY] = { defaultRepo };
  },

  /**
   * Find every issue/PR reference in `text`, deduplicated by id and
   * excluding matches inside code spans.
   *
   * @param {string} text User prompt.
   * @param {[number, number][]} codeRanges Output of `findCodeRanges(text)`.
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {GithubIssueMatch[]}
   */
  detect(text, codeRanges, ctx) {
    const matches = [];
    const seen = new Set();
    const push = (owner, repo, number) => {
      const id = `github:${owner}/${repo}#${number}`;
      if (seen.has(id)) return;
      seen.add(id);
      matches.push({ id, owner, repo, number });
    };

    for (const m of text.matchAll(FULL_URL_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      push(m[1], m[2], m[3]);
    }
    for (const m of text.matchAll(SHORT_REF_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      push(m[1], m[2], m[3]);
    }
    const defaultRepo = ctx.state[STATE_KEY]?.defaultRepo;
    if (defaultRepo) {
      const [owner, repo] = defaultRepo.split("/");
      for (const m of text.matchAll(BARE_REF_PATTERN)) {
        if (isInsideCode(m.index, codeRanges)) continue;
        push(owner, repo, m[1]);
      }
    }
    return matches;
  },

  /**
   * Fetch and format a single issue or PR. PRs get a second `gh pr view`
   * call for branch/review/check details. Returns `null` on any CLI failure
   * so the orchestrator can skip silently rather than abort the prompt.
   *
   * @param {GithubIssueMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>} Markdown block or `null` on failure.
   */
  async fetch(match, ctx) {
    const { owner, repo, number } = match;
    const issueResp = await ctx.runner(
      "gh",
      ["api", `repos/${owner}/${repo}/issues/${number}`],
      { cwd: ctx.cwd },
    );
    if (issueResp.code !== 0) return null;
    const data = safeJsonParse(issueResp.stdout);
    if (!data) return null;

    const isPullRequest = !!data.pull_request;
    let prDetails = null;
    if (isPullRequest) {
      const prResp = await ctx.runner(
        "gh",
        [
          "pr", "view", number,
          "--repo", `${owner}/${repo}`,
          "--json", "title,state,author,baseRefName,headRefName,body,url,reviewDecision,isDraft,mergeable,statusCheckRollup,labels",
        ],
        { cwd: ctx.cwd },
      );
      if (prResp.code === 0) prDetails = safeJsonParse(prResp.stdout);
    }
    return formatIssueOrPr({ owner, repo, number, isPullRequest, data, prDetails });
  },

  /**
   * @param {GithubIssueMatch} match
   * @returns {string}
   */
  summarize(match) {
    return `gh ${match.owner}/${match.repo}#${match.number}`;
  },
};

/**
 * Render the markdown block. Pure function.
 *
 * @param {Object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.number
 * @param {boolean} args.isPullRequest
 * @param {Object} args.data Raw `gh api .../issues/N` response.
 * @param {Object|null} args.prDetails Optional `gh pr view --json` response.
 * @returns {string} Markdown block.
 */
function formatIssueOrPr({ owner, repo, number, isPullRequest, data, prDetails }) {
  const lines = [];
  const kind = isPullRequest ? "PR" : "Issue";
  lines.push(`#### ${kind} ${owner}/${repo}#${number}: ${data.title ?? ""}`);
  if (data.html_url) lines.push(`- URL: ${data.html_url}`);
  const stateExtra = data.state === "closed" && data.state_reason ? ` (${data.state_reason})` : "";
  lines.push(`- State: ${data.state}${stateExtra}`);
  lines.push(`- Author: ${data.user?.login ?? "?"}`);
  if (data.labels?.length) {
    lines.push(`- Labels: ${data.labels.map((label) => label.name).join(", ")}`);
  }

  if (isPullRequest && prDetails) {
    if (prDetails.headRefName && prDetails.baseRefName) {
      lines.push(`- Branch: ${prDetails.headRefName} -> ${prDetails.baseRefName}`);
    }
    if (prDetails.isDraft) lines.push("- Draft: yes");
    if (prDetails.reviewDecision) lines.push(`- Review: ${prDetails.reviewDecision}`);
    if (prDetails.mergeable) lines.push(`- Mergeable: ${prDetails.mergeable}`);
    const checks = prDetails.statusCheckRollup;
    if (Array.isArray(checks) && checks.length) {
      const failing = checks.filter((check) => {
        const state = String(check.conclusion ?? check.state ?? "").toUpperCase();
        return state && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state);
      }).length;
      lines.push(`- Checks: ${checks.length} total, ${failing} failing/pending`);
    }
  }

  const body = (isPullRequest && prDetails ? prDetails.body : data.body) ?? "";
  if (String(body).trim()) {
    lines.push("", "**Body:**", String(body).trim());
  }

  lines.push("");
  const refetchCmd = isPullRequest
    ? `gh pr view ${number} --repo ${owner}/${repo} --comments`
    : `gh issue view ${number} --repo ${owner}/${repo} --comments`;
  lines.push(`Refetch with comments: \`${refetchCmd}\``);
  return lines.join("\n");
}
