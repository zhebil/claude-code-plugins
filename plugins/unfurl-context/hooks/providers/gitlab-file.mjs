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
 * gitlab.com host, /-/blob/ and /-/raw/ both supported. Group 1 is the
 * project full path (subgroups allowed), group 2 is the mode, group 3 is
 * the ref (single segment), group 4 is the rest (path + optional anchor).
 */
const FILE_URL_PATTERN =
  /https?:\/\/gitlab\.com\/((?:[\w.-]+\/)+[\w.-]+?)\/-\/(blob|raw)\/([^/?#\s]+)\/([^\s)\]>"']+)/g;

/**
 * @typedef {import("../lib/file-text.mjs").LineAnchor} LineAnchor
 *
 * @typedef {Object} GitlabFileMatch
 * @property {string} id Stable id like `gitlab-file:group/proj@ref/path[#L10-L20]`.
 * @property {string} fullPath Project path (may include subgroups).
 * @property {string} ref Branch, tag, or commit SHA.
 * @property {string} path File path within the repo (URL chars left as-is).
 * @property {LineAnchor|null} anchor
 */

/**
 * Provider that enriches GitLab file URLs with the file contents (or a
 * line-anchored slice).
 *
 * Recognized URL forms:
 *   - https://gitlab.com/<group>/<project>/-/blob/<ref>/<path>[#L10[-L20]]
 *   - https://gitlab.com/<group>/<project>/-/raw/<ref>/<path>
 *
 * Subgroups are supported. Anchor formats `#L10`, `#L10-20` (GitLab's
 * native form), and `#L10-L20` are all accepted.
 *
 * Multi-segment branch names are NOT auto-resolved: the first path
 * segment after `/-/blob/` or `/-/raw/` is treated as the ref. If the
 * resulting Files API call 404s, the match is silently dropped.
 */
export const gitlabFileProvider = {
  name: "gitlab-file",

  /**
   * @param {string} text
   * @param {[number, number][]} codeRanges
   * @param {import("./index.mjs").EnrichmentContext} [_ctx]
   * @returns {GitlabFileMatch[]}
   */
  detect(text, codeRanges, _ctx) {
    const matches = [];
    const seen = new Set();
    for (const m of text.matchAll(FILE_URL_PATTERN)) {
      if (isInsideCode(m.index, codeRanges)) continue;
      const fullPath = m[1];
      const ref = m[3];
      const rawTail = m[4];
      const parsed = parseFileTail(rawTail);
      if (!parsed) continue;
      if (BINARY_EXTENSIONS.has(fileExtension(parsed.path))) continue;
      const anchorPart = parsed.anchor
        ? `#L${parsed.anchor.start}-L${parsed.anchor.end}`
        : "";
      const id = `gitlab-file:${fullPath}@${ref}/${parsed.path}${anchorPart}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({ id, fullPath, ref, path: parsed.path, anchor: parsed.anchor });
    }
    return matches;
  },

  /**
   * @param {GitlabFileMatch} match
   * @param {import("./index.mjs").EnrichmentContext} ctx
   * @returns {Promise<string|null>}
   */
  async fetch(match, ctx) {
    const { fullPath, ref, path, anchor } = match;
    const encodedProject = encodeURIComponent(fullPath);
    const encodedFile = encodeURIComponent(path);
    const encodedRef = encodeURIComponent(ref);
    const resp = await ctx.runner(
      "glab",
      [
        "api",
        `projects/${encodedProject}/repository/files/${encodedFile}/raw?ref=${encodedRef}`,
      ],
      { cwd: ctx.cwd },
    );
    if (resp.code !== 0) return null;
    const content = resp.stdout;
    if (content === "" || content == null) return null;
    return formatFile({ fullPath, ref, path, anchor, content });
  },

  /**
   * @param {GitlabFileMatch} match
   * @returns {string}
   */
  summarize(match) {
    const anchorPart = match.anchor
      ? `#L${match.anchor.start}-L${match.anchor.end}`
      : "";
    return `glab-file ${match.fullPath}:${match.path}${anchorPart}`;
  },
};

/**
 * @param {Object} args
 * @param {string} args.fullPath
 * @param {string} args.ref
 * @param {string} args.path
 * @param {LineAnchor|null} args.anchor
 * @param {string} args.content
 * @returns {string}
 */
function formatFile({ fullPath, ref, path, anchor, content }) {
  const body = buildFileBody({ content, anchor, langExt: fileExtension(path) });

  // GitLab's URL anchor convention is `L10-20`, not `L10-L20`. Render the
  // native form so the link works when copied back into a browser.
  const urlAnchor = body.useAnchor
    ? body.useAnchor.start === body.useAnchor.end
      ? `#L${body.useAnchor.start}`
      : `#L${body.useAnchor.start}-${body.useAnchor.end}`
    : "";
  const encodedPath = encodeUrlPath(path);
  const encodedRef = encodeUrlPath(ref);

  const lines = [];
  lines.push(`#### File ${fullPath}@${ref} - ${path}${body.headingSuffix}`);
  lines.push(`- URL: https://gitlab.com/${fullPath}/-/blob/${encodedRef}/${encodedPath}${urlAnchor}`);
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
  const encodedProject = encodeURIComponent(fullPath);
  const apiEncodedFile = encodeURIComponent(path);
  const apiEncodedRef = encodeURIComponent(ref);
  lines.push(
    `Refetch: \`glab api projects/${encodedProject}/repository/files/${apiEncodedFile}/raw?ref=${apiEncodedRef}\``,
  );
  return lines.join("\n");
}
