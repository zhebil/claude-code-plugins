/**
 * Markdown shell shared by repo + issue providers.
 *
 * The duplicated structure across github-repo / gitlab-repo / github-issue /
 * gitlab-issue is the *layout*: an h4 heading, a list of `- Label: value`
 * bullets, an optional body section, then a refetch hint. The duplicated
 * *field extraction* is barely-duplicated - GitHub and GitLab disagree on
 * almost every key name (`html_url` vs `web_url`, `stargazers_count` vs
 * `star_count`, `body` vs `description`, label shape, mergeable shape, ...).
 * This module only abstracts the layout. Each provider keeps a small
 * `formatX` that pulls fields out of its raw API response and hands a clean
 * `bullets` array here.
 */

const MAX_README_CHARS_DEFAULT = 12000;

/**
 * @typedef {[string, *]} Bullet `[label, value]`. `null`/`undefined`/`""`
 *   values are dropped so callers can list-push unconditionally.
 */

/**
 * @typedef {Object} EntityBody
 * @property {string} title Section header, e.g. "Body", "Description", "README".
 * @property {string} text  The body text. Trimmed before rendering; if empty
 *   after trimming, the section is omitted.
 */

/**
 * Render the markdown block.
 *
 * @param {Object} args
 * @param {string} args.heading The text after `#### ` (e.g. `"Issue me/proj#3: Hello"`).
 * @param {Bullet[]} [args.bullets=[]]
 * @param {EntityBody|null} [args.body=null]
 * @param {string} [args.refetch=""] Trailing line; pass the full line
 *   verbatim (e.g. ``"Refetch: `gh api ...`"``). Empty string omits it.
 * @returns {string}
 */
export function renderEntity({ heading, bullets = [], body = null, refetch = "" }) {
  const lines = [];
  lines.push(`#### ${heading}`);
  for (const entry of bullets) {
    if (!entry) continue;
    const [label, value] = entry;
    if (value == null) continue;
    const text = typeof value === "string" ? value : String(value);
    if (text === "") continue;
    lines.push(`- ${label}: ${text}`);
  }

  if (body) {
    const trimmed = String(body.text ?? "").trim();
    if (trimmed) {
      lines.push("", `**${body.title}:**`, trimmed);
    }
  }

  if (refetch) {
    lines.push("", refetch);
  }
  return lines.join("\n");
}

/**
 * Trim a README and append a truncation note if it exceeds `max` chars.
 * Returns `""` for null/empty input so callers can detect "no README".
 *
 * @param {string|null|undefined} text
 * @param {number} [max=MAX_README_CHARS_DEFAULT]
 * @returns {string}
 */
export function truncateReadme(text, max = MAX_README_CHARS_DEFAULT) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n\n...(README truncated, ${trimmed.length - max} more chars)`;
}

export const MAX_README_CHARS = MAX_README_CHARS_DEFAULT;
