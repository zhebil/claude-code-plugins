import { isInsideCode } from "../lib/code-ranges.mjs";

const MAX_FILE_CHARS = 12000;

/**
 * Extensions whose contents are not useful as text. Detection drops these
 * before fetching, so we don't waste an API round-trip or pollute the
 * prompt with raw bytes. `.svg` is intentionally treated as text.
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

/** Extension -> markdown fence info-string. Unknown extensions emit a fence with no language tag. */
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
 * github.com host: matches both /blob/<ref>/<path> and /raw/<ref>/<path>.
 * The path capture is intentionally permissive (anything that isn't
 * whitespace or a markdown delimiter); trailing punctuation is stripped
 * post-hoc by {@link parseTail}.
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

const TRAILING_PUNCT = /[.,!?;:)\]>"']+$/;

/**
 * @typedef {Object} LineAnchor
 * @property {number} start 1-indexed inclusive.
 * @property {number} end   1-indexed inclusive (== start for single-line anchor).
 */

/**
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
      const parsed = parseTail(tail);
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
 * Parse `L10` or `L10-L20` (case-sensitive, GitHub's actual format) into
 * a normalized {start, end}. Returns `null` for any other shape.
 *
 * @param {string|null} s
 * @returns {LineAnchor|null}
 */
function parseAnchor(s) {
  if (!s) return null;
  const m = /^L(\d+)(?:-L(\d+))?$/.exec(s);
  if (!m) return null;
  let start = parseInt(m[1], 10);
  let end = m[2] != null ? parseInt(m[2], 10) : start;
  // Normalize inverted ranges before the lower-bound check, so that
  // `#L10-L0` (would-be-invalid end) doesn't slip through after the swap.
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
 * Encode a path-like value (slashes preserved) for safe interpolation
 * into a URL. Each `/`-separated segment is independently
 * encodeURIComponent'd, which neutralizes stray `&`, `?`, `#`, or
 * unicode oddities without mangling the segment boundaries the GitHub
 * Contents API expects.
 *
 * @param {string} value
 * @returns {string}
 */
function encodeUrlPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * Pick a fence length that won't collide with any backtick run inside `body`.
 * Markdown allows arbitrary-length fences as long as the closing fence is
 * at least as long as the opener.
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
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.ref
 * @param {string} args.path
 * @param {LineAnchor|null} args.anchor
 * @param {string} args.content Raw file content from the Contents API.
 * @returns {string}
 */
function formatFile({ owner, repo, ref, path, anchor, content }) {
  // A single trailing newline on a file produces a phantom empty line
  // when split on "\n"; strip exactly one so totalLines matches the
  // common-sense count and an out-of-range guard works correctly.
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
  const urlAnchor = useAnchor
    ? `#L${useAnchor.start}-L${useAnchor.end}`
    : "";
  const encodedPath = encodeUrlPath(path);
  const encodedRef = encodeUrlPath(ref);

  const lines = [];
  lines.push(`#### File ${owner}/${repo}@${ref} - ${path}${headingSuffix}`);
  lines.push(`- URL: https://github.com/${owner}/${repo}/blob/${encodedRef}/${encodedPath}${urlAnchor}`);
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
  lines.push(
    `Refetch: \`gh api repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodedRef} -H "Accept: application/vnd.github.raw"\``,
  );
  return lines.join("\n");
}
