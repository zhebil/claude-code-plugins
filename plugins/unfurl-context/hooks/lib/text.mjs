/**
 * Pick the first non-empty string-like value from a list. Tolerates Jira-style
 * objects that wrap a label in `{ name }`, `{ displayName }`, or `{ value }`.
 * Empty strings are treated as missing - including object fields - so e.g.
 * `{ displayName: "", name: "Real" }` yields `"Real"` rather than `""`.
 *
 * @param {...*} values Candidate values, in priority order.
 * @returns {string} The first usable string, or `""` if none qualify.
 */
export function pickFirstString(...values) {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "object") {
      const fromObject = firstNonEmpty(v.displayName, v.name, v.value);
      if (fromObject) return fromObject;
    }
  }
  return "";
}

/**
 * Return the first argument that is a non-empty string. Used to resolve
 * the priority chain inside an object label (displayName -> name -> value)
 * without short-circuiting on an empty string.
 *
 * @param {...*} candidates
 * @returns {string} First non-empty string, or `""`.
 */
function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return "";
}

/**
 * Coerce any value to a flat string for display. Primitives stringify
 * directly; objects/arrays are JSON-encoded; nullish becomes `""`. Used when
 * formatting heterogeneous fields from external APIs (Sentry tags, Jira
 * fields, etc.) into markdown.
 *
 * @param {*} value Arbitrary value.
 * @returns {string}
 */
export function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
