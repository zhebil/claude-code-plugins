import { isInsideCode } from "../lib/code-ranges.mjs";
import {
  BINARY_EXTENSIONS,
  buildFileBody,
  encodeUrlPath,
  fileExtension,
  outOfRangeNote,
  parseFileTail,
  truncationSuffix,
} from "../lib/file-text.mjs";

/**
 * github.com host: matches both /blob/<ref>/<path> and /raw/<ref>/<path>.
 * The path capture is intentionally permissive (anything that isn't
 * whitespace or a markdown delimiter); trailing punctuation is stripped
 * post-hoc inside parseFileTail().
 */
const BLOB_URL_PATTERN =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|raw)\/([^/?#\s]+)\/([^\s)\]>"']+)/g;

/** raw.githubusercontent.com host: /<owner>/<repo>/<ref>/<path>. */
const RAW_HOST_PATTERN =
  /https?:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^/?#\s]+)\/([^\s)\]>"']+)/g;

/**
 * GitHub's "Copy permalink" button emits URLs like
 * `/blob/refs/heads/<branch>/<path>` or `/blob/refs/tags/<tag>/<path>`,
 * where the literal `refs/heads/` prefix is part of the ref. The base
 * patterns above capture `refs` as the single-segment ref; this helper
 * peels off the trailing `heads/<x>/` or `tags/<x>/` and re-slices.
 */
const REFS_PREFIX_PATTERN = /^(heads|tags)\/([^/]+)\/(.*)$/;

/**
 * @typedef {import("../lib/file-text.mjs").LineAnchor} LineAnchor
 *
 * @typedef {Object} GithubFileMatch
 * @property {string} id Stable id like `github-file:owner/repo@ref/path[#L10-L20]`.
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref Branch name, tag, or SHA. First segment after /blob|raw/.
 * @property {string} path File path within the repo, URL-encoded chars left as-is.
 * @property {LineAnchor|null} anchor
 */

/**
 * Provider that enriches GitHub file URLs with the file contents (or a
 * line-anchored slice). Recognized URL forms:
 *
 *   - https://github.com/<owner>/<repo>/blob/<ref>/<path>[#L<a>[-L<b>]]
 *   - https://github.com/<owner>/<repo>/raw/<ref>/<path>
 *   - https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
 *
 * Directory views (/tree/) and blame (/blame/) are not handled.
 *
 * Multi-segment branch names (e.g. `feature/foo`) are NOT auto-resolved: we
 * always treat the first path segment after /blob|raw/ as the ref. If the
 * resulting Contents API call 404s, the match is silently dropped.
 */
export const githubFileProvider = {
  name: "github-file",

  /**
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx] Unused; kept for
   *   contract compatibility with other providers.
   * @returns {GithubFileMatch[]}
   */
  detect(text, codeRanges, _ctx) {
    const matches = [];
    const seen = new Set();

    const push = (owner, repo, rawRef, rawTail, position) => {
      if (isInsideCode(position, codeRanges)) return;
      const { ref, tail } = expandRefsPrefix(rawRef, rawTail);
      const parsed = parseFileTail(tail);
      if (!parsed) return;
      if (BINARY_EXTENSIONS.has(fileExtension(parsed.path))) return;
      const anchorPart = parsed.anchor
        ? `#L${parsed.anchor.start}-L${parsed.anchor.end}`
        : "";
      const id = `github-file:${owner}/${repo}@${ref}/${parsed.path}${anchorPart}`;
      if (seen.has(id)) return;
      seen.add(id);
      matches.push({ id, owner, repo, ref, path: parsed.path, anchor: parsed.anchor });
    };

    for (const m of text.matchAll(BLOB_URL_PATTERN)) {
      push(m[1], m[2], m[3], m[4], m.index);
    }
    for (const m of text.matchAll(RAW_HOST_PATTERN)) {
      push(m[1], m[2], m[3], m[4], m.index);
    }
    return matches;
  },

  /**
   * @param {GithubFileMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const { owner, repo, ref, path, anchor } = match;
    const resp = await ctx.runner(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/contents/${encodeUrlPath(path)}?ref=${encodeUrlPath(ref)}`,
        "-H",
        "Accept: application/vnd.github.raw",
      ],
      { cwd: ctx.cwd },
    );
    if (resp.code !== 0) return null;
    const content = resp.stdout;
    // Treat zero-byte files as a fetch miss: the metadata header alone
    // would be misleading and there is nothing useful to slice.
    if (content === "" || content == null) return null;
    return formatFile({ owner, repo, ref, path, anchor, content });
  },

  /**
   * @param {GithubFileMatch} match
   * @returns {string}
   */
  summarize(match) {
    const anchorPart = match.anchor
      ? `#L${match.anchor.start}-L${match.anchor.end}`
      : "";
    return `file ${match.owner}/${match.repo}:${match.path}${anchorPart}`;
  },
};

/**
 * If the regex matched the GitHub "permalink" form `/blob/refs/heads/<x>/<path>`
 * (or `/blob/refs/tags/<x>/<path>`), the base regex captures `refs` as the
 * single-segment ref. Reassemble so `ref` becomes `refs/heads/<x>` and the
 * tail loses the consumed `heads/<x>/` prefix.
 *
 * @param {string} ref
 * @param {string} rawTail
 * @returns {{ref: string, tail: string}}
 */
function expandRefsPrefix(ref, rawTail) {
  if (ref !== "refs") return { ref, tail: rawTail };
  const m = REFS_PREFIX_PATTERN.exec(rawTail);
  if (!m) return { ref, tail: rawTail };
  return { ref: `refs/${m[1]}/${m[2]}`, tail: m[3] };
}

/**
 * @param {Object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.ref
 * @param {string} args.path
 * @param {LineAnchor|null} args.anchor
 * @param {string} args.content
 * @returns {string}
 */
function formatFile({ owner, repo, ref, path, anchor, content }) {
  const body = buildFileBody({ content, anchor, langExt: fileExtension(path) });

  const urlAnchor = body.useAnchor
    ? `#L${body.useAnchor.start}-L${body.useAnchor.end}`
    : "";
  const encodedPath = encodeUrlPath(path);
  const encodedRef = encodeUrlPath(ref);

  const lines = [];
  lines.push(`#### File ${owner}/${repo}@${ref} - ${path}${body.headingSuffix}`);
  lines.push(`- URL: https://github.com/${owner}/${repo}/blob/${encodedRef}/${encodedPath}${urlAnchor}`);
  lines.push(`- Ref: ${ref}`);
  lines.push(`- Size: ${content.length} chars, ${body.totalLines} lines`);
  if (body.outOfRange) {
    lines.push(`- ${outOfRangeNote(anchor, body.totalLines)}`);
  }
  lines.push("");
  lines.push(`${body.fence}${body.lang}`);
  lines.push(body.rendered);
  lines.push(body.fence);
  const tail = truncationSuffix(body.truncatedChars, !!body.useAnchor);
  if (tail) {
    lines.push("", tail);
  }
  lines.push("");
  lines.push(
    `Refetch: \`gh api repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodedRef} -H "Accept: application/vnd.github.raw"\``,
  );
  return lines.join("\n");
}
