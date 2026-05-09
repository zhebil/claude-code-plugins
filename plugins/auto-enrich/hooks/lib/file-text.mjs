/**
 * Shared helpers for file-content providers (github-file, gitlab-file, ...).
 *
 * The platform-specific bits (URL detection, the rendered-URL anchor format,
 * and the refetch command) stay in the provider. Everything below is platform
 * agnostic: extension classification, ref/path encoding, fence selection, and
 * the slice/clamp/truncate/number-the-lines core of the rendered code block.
 */

export const MAX_FILE_CHARS = 12000;

/**
 * Extensions whose contents are not useful as text. Providers drop these in
 * `detect()` so the orchestrator never spends a CLI call fetching binary
 * bytes. `.svg` is intentionally treated as text.
 */
export const BINARY_EXTENSIONS = new Set([
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
export const EXTENSION_LANGUAGE = {
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

const TRAILING_PUNCT = /[.,!?;:)\]>"']+$/;

/**
 * Lenient anchor regex: accepts GitHub's strict `L10` / `L10-L20` form and
 * GitLab's native `L10-20` form. The second `L?` makes the trailing `L`
 * optional. Used by both file providers; the provider chooses how to render
 * the anchor back into a URL.
 */
const ANCHOR_PATTERN = /^L(\d+)(?:-L?(\d+))?$/;

/**
 * @typedef {Object} LineAnchor
 * @property {number} start 1-indexed inclusive.
 * @property {number} end   1-indexed inclusive (== start for single-line anchor).
 */

/**
 * @param {string} path
 * @returns {string} The lowercased extension including the leading dot, or
 *   "" for dotfiles / extensionless names.
 */
export function fileExtension(path) {
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
 * unicode oddities without mangling the segment boundaries the GitHub /
 * GitLab APIs expect.
 *
 * @param {string} value
 * @returns {string}
 */
export function encodeUrlPath(value) {
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
export function fenceFor(body) {
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
 * Parse the captured path-and-tail (everything after `<ref>/` in a file URL).
 * Strips trailing sentence punctuation, drops the query string, and parses
 * the URL fragment as an optional line anchor.
 *
 * @param {string} rawTail
 * @returns {{path: string, anchor: LineAnchor|null} | null}
 */
export function parseFileTail(rawTail) {
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
  return { path, anchor: parseLineAnchor(anchorStr) };
}

/**
 * Parse `L10`, `L10-L20`, or `L10-20` into a normalized `{start, end}`.
 * Returns `null` for any other shape, including out-of-bound or non-numeric
 * values.
 *
 * @param {string|null} s
 * @returns {LineAnchor|null}
 */
export function parseLineAnchor(s) {
  if (!s) return null;
  const m = ANCHOR_PATTERN.exec(s);
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
 * @typedef {Object} FileBody
 * @property {number} totalLines
 * @property {LineAnchor|null} useAnchor Clamped anchor that was actually
 *   rendered. `null` when the original anchor was out of range or absent.
 * @property {boolean} outOfRange True when the supplied anchor was above the
 *   file's last line. Caller is expected to render an "out of range" note.
 * @property {string} headingSuffix `" - lines 10-12"` or `""`. Append to the
 *   `#### File ...` heading.
 * @property {string} fence Backtick fence chosen to avoid collisions.
 * @property {string} lang Markdown info-string for the fence (e.g. `python`),
 *   or `""` for unknown extensions.
 * @property {string} rendered The body text (line-numbered slice or full
 *   file), already truncated to `maxChars`.
 * @property {number} truncatedChars 0 when `rendered` fits under `maxChars`.
 */

/**
 * Slice + clamp + line-number + truncate. Pure function; no IO.
 *
 * The caller wraps the returned `{fence, lang, rendered, truncatedChars}`
 * into a fenced code block and composes the surrounding metadata lines
 * (URL, refetch command). Splitting the work this way keeps URL anchor
 * conventions (`#L10-L20` for GitHub, `#L10-20` for GitLab) and refetch
 * command syntax in the provider where they belong.
 *
 * @param {Object} args
 * @param {string} args.content Raw file content as returned by the platform
 *   API. A single trailing newline is stripped before counting lines.
 * @param {LineAnchor|null} args.anchor User-requested line range, or null.
 * @param {number} [args.maxChars=MAX_FILE_CHARS]
 * @param {string} [args.langExt] File extension (with leading dot). When
 *   present, used to look up the fence language tag.
 * @returns {FileBody}
 */
export function buildFileBody({ content, anchor, maxChars = MAX_FILE_CHARS, langExt = "" }) {
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
  if (rendered.length > maxChars) {
    truncatedChars = rendered.length - maxChars;
    rendered = rendered.slice(0, maxChars);
  }

  const fence = fenceFor(rendered);
  const lang = EXTENSION_LANGUAGE[langExt] || "";
  const headingSuffix = useAnchor ? ` - lines ${useAnchor.start}-${useAnchor.end}` : "";

  return { totalLines, useAnchor, outOfRange, headingSuffix, fence, lang, rendered, truncatedChars };
}

/**
 * Format the "out of range" note for an anchor whose start is past the last
 * line. Returns just the message text - caller prepends `- ` and appends to
 * the metadata bullets.
 *
 * @param {LineAnchor} requested The original (pre-clamp) anchor.
 * @param {number} totalLines
 * @returns {string}
 */
export function outOfRangeNote(requested, totalLines) {
  const anchorStr = requested.start === requested.end
    ? `#L${requested.start}`
    : `#L${requested.start}-L${requested.end}`;
  return `Note: line anchor ${anchorStr} is out of range (file has ${totalLines} lines); showing the full file`;
}

/**
 * "...(content truncated, N more chars). HINT" tail, or "" when nothing was
 * truncated. The hint adapts to whether the content was anchored: if it was,
 * suggesting `#L10-L20` is unhelpful (the user already used a range).
 *
 * @param {number} truncatedChars
 * @param {boolean} anchored Whether `useAnchor` was non-null in the body.
 * @returns {string}
 */
export function truncationSuffix(truncatedChars, anchored) {
  if (truncatedChars <= 0) return "";
  const hint = anchored
    ? "Try a smaller line range."
    : "For specific lines, paste with #L10-L20.";
  return `...(content truncated, ${truncatedChars} more chars). ${hint}`;
}
