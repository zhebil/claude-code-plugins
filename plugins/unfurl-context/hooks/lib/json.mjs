/**
 * Parse JSON without throwing. Returns `null` on any parse failure or when
 * given a non-JSON string. Use when input may be malformed CLI output.
 *
 * @param {string} text Raw JSON text.
 * @returns {*} Parsed value, or `null` on failure.
 */
export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
