import { isInsideCode } from "../lib/code-ranges.mjs";

const MAX_FILE_CHARS = 12000;

/**
 * Extensions whose contents are not useful as text. Detection drops these
 * before fetching, so we don't waste an API round-trip or pollute the
 * prompt with raw bytes. Kept in sync with the same list in github-file.mjs.
 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".heic",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".wasm", ".jar", ".pyc",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flac", ".ogg", ".wav",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".db", ".sqlite", ".sqlite3",
  ".bin", ".iso", ".dat",
]);

/** Extension -> markdown fence info-string. Kept in sync with github-file.mjs. */
const EXTENSION_LANGUAGE = {
  ".py": "python",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx",
  ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift",
  ".rb": "ruby", ".php": "php",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".cs": "csharp",
  ".sh": "bash", ".zsh": "bash", ".bash": "bash",
  ".yaml": "yaml", ".yml": "yaml",
  ".json": "json", ".toml": "toml", ".xml": "xml",
  ".html": "html", ".css": "css", ".scss": "scss", ".less": "less",
  ".md": "markdown", ".markdown": "markdown",
  ".sql": "sql",
  ".tf": "hcl", ".hcl": "hcl",
  ".proto": "protobuf",
  ".svg": "xml",
  ".lua": "lua",
  ".scala": "scala",
  ".r": "r",
  ".pl": "perl",
  ".dart": "dart",
  ".ex": "elixir", ".exs": "elixir",
};

/**
 * gitlab.com host, /-/blob/ and /-/raw/ both supported. Group 1 is the
 * project full path (subgroups allowed), group 2 is the mode, group 3 is
 * the ref (single segment), group 4 is the rest (path + optional anchor).
 */
const FILE_URL_PATTERN =
  /https?:\/\/gitlab\.com\/((?:[\w.-]+\/)+[\w.-]+?)\/-\/(blob|raw)\/([^/?#\s]+)\/([^\s)\]>"']+)/g;

const TRAILING_PUNCT = /[.,!?;:)\]>"']+$/;

/**
 * @typedef {Object} LineAnchor
 * @property {number} start 1-indexed inclusive.
 * @property {number} end   1-indexed inclusive (== start for single-line anchor).
 */

/**
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
      const parsed = parseTail(rawTail);
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
    // Treat zero-byte files as a fetch miss: the metadata header alone
    // would be misleading and there is nothing useful to slice.
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
 * Parse the captured path-and-tail (everything after `<ref>/`). Strips
 * trailing sentence punctuation, drops the query string, and parses the
 * URL fragment as a possible line anchor.
 *
 * @param {string} rawTail
 * @returns {{path: string, anchor: LineAnchor|null} | null}
 */
function parseTail(rawTail) {
  const cleaned = rawTail.replace(TRAILING_PUNCT, "");
  if (!cleaned) return null;
  let withoutAnchor = cleaned;
  let anchorStr = null;
  const hashIdx = withoutAnchor.indexOf("#");
  if (hashIdx >= 0) {
    anchorStr = withoutAnchor.slice(hashIdx + 1);
    withoutAnchor = withoutAnchor.slice(0, hashIdx);
  }
  const queryIdx = withoutAnchor.indexOf("?");
  const path = queryIdx >= 0 ? withoutAnchor.slice(0, queryIdx) : withoutAnchor;
  if (!path) return null;
  return { path, anchor: parseAnchor(anchorStr) };
}

/**
 * Accept GitLab's native `L10`/`L10-20` form as well as GitHub's
 * `L10-L20` (since users sometimes paste the `-L` style out of habit).
 *
 * @param {string|null} s
 * @returns {LineAnchor|null}
 */
function parseAnchor(s) {
  if (!s) return null;
  const m = /^L(\d+)(?:-L?(\d+))?$/.exec(s);
  if (!m) return null;
  let start = parseInt(m[1], 10);
  let end = m[2] != null ? parseInt(m[2], 10) : start;
  if (start > end) [start, end] = [end, start];
  if (start < 1) return null;
  return { start, end };
}

/**
 * @param {string} path
 * @returns {string} The lowercased extension including the leading dot, or
 *   "" for dotfiles / extensionless names.
 */
function fileExtension(path) {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot).toLowerCase();
}

/**
 * Encode each `/`-separated segment independently so stray `&`, `?`,
 * `#`, or unicode oddities are neutralized without mangling segment
 * boundaries.
 *
 * @param {string} value
 * @returns {string}
 */
function encodeUrlPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * Pick a fence length that won't collide with any backtick run inside `body`.
 *
 * @param {string} body
 * @returns {string}
 */
function fenceFor(body) {
  let max = 2;
  let run = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "`") {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(max + 1);
}

/**
 * Render the markdown block. Pure function.
 *
 * @param {Object} args
 * @param {string} args.fullPath
 * @param {string} args.ref
 * @param {string} args.path
 * @param {LineAnchor|null} args.anchor
 * @param {string} args.content Raw file content from the Files API.
 * @returns {string}
 */
function formatFile({ fullPath, ref, path, anchor, content }) {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  const allLines = normalized.split("\n");
  const totalLines = allLines.length;

  let outOfRange = false;
  let useAnchor = anchor;
  if (useAnchor && useAnchor.start > totalLines) {
    outOfRange = true;
    useAnchor = null;
  }
  if (useAnchor) {
    useAnchor = {
      start: useAnchor.start,
      end: Math.min(useAnchor.end, totalLines),
    };
  }

  const sliceLines = useAnchor
    ? allLines.slice(useAnchor.start - 1, useAnchor.end)
    : allLines;

  let renderedLines;
  if (useAnchor) {
    const padWidth = String(useAnchor.end).length;
    renderedLines = sliceLines.map((line, i) =>
      `${String(useAnchor.start + i).padStart(padWidth, " ")}: ${line}`,
    );
  } else {
    renderedLines = sliceLines;
  }

  let rendered = renderedLines.join("\n");
  let truncatedChars = 0;
  if (rendered.length > MAX_FILE_CHARS) {
    truncatedChars = rendered.length - MAX_FILE_CHARS;
    rendered = rendered.slice(0, MAX_FILE_CHARS);
  }

  const fence = fenceFor(rendered);
  const lang = EXTENSION_LANGUAGE[fileExtension(path)] || "";

  const headingSuffix = useAnchor
    ? ` - lines ${useAnchor.start}-${useAnchor.end}`
    : "";
  // GitLab's URL anchor convention is `L10-20`, not `L10-L20`. Render the
  // native form so the link works when copied back into a browser.
  const urlAnchor = useAnchor
    ? useAnchor.start === useAnchor.end
      ? `#L${useAnchor.start}`
      : `#L${useAnchor.start}-${useAnchor.end}`
    : "";
  const encodedPath = encodeUrlPath(path);
  const encodedRef = encodeUrlPath(ref);

  const lines = [];
  lines.push(`#### File ${fullPath}@${ref} - ${path}${headingSuffix}`);
  lines.push(`- URL: https://gitlab.com/${fullPath}/-/blob/${encodedRef}/${encodedPath}${urlAnchor}`);
  lines.push(`- Ref: ${ref}`);
  lines.push(`- Size: ${content.length} chars, ${totalLines} lines`);
  if (outOfRange) {
    const requested = anchor.start === anchor.end
      ? `#L${anchor.start}`
      : `#L${anchor.start}-L${anchor.end}`;
    lines.push(`- Note: line anchor ${requested} is out of range (file has ${totalLines} lines); showing the full file`);
  }
  lines.push("");
  lines.push(`${fence}${lang}`);
  lines.push(rendered);
  lines.push(fence);
  if (truncatedChars > 0) {
    lines.push("");
    const hint = useAnchor
      ? "Try a smaller line range."
      : "For specific lines, paste with #L10-L20.";
    lines.push(`...(content truncated, ${truncatedChars} more chars). ${hint}`);
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
