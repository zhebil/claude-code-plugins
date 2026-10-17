/**
 * @typedef {[number, number]} CodeRange A `[startInclusive, endExclusive)`
 *   tuple covering text we should treat as code (fenced block or inline span).
 */

/**
 * Find every code span and fenced code block in `text`, so that references
 * appearing inside backticks (e.g. \`SA-123\` or \`\`\`...XYZ-456...\`\`\`)
 * can be excluded from enrichment.
 *
 * Recognized as code:
 *   - Triple-backtick fenced blocks ``` ... ```
 *   - Single-backtick inline spans `...`
 *
 * Unclosed fences are treated as running to end-of-text (so anything after
 * an opening ``` is considered code). Stray single backticks without a
 * closing pair are ignored - text resumes scanning normally.
 *
 * @param {string} text The user prompt to scan.
 * @returns {CodeRange[]} Sorted, non-overlapping ranges in occurrence order.
 */
export function findCodeRanges(text) {
  const ranges = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end === -1) {
        ranges.push([i, text.length]);
        break;
      }
      ranges.push([i, end + 3]);
      i = end + 3;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) {
        i++;
        continue;
      }
      ranges.push([i, end + 1]);
      i = end + 1;
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * Test whether a character offset falls inside any code range. Used by
 * provider detectors to skip references that the user explicitly typed in
 * backticks (verbatim text, not a real reference to enrich).
 *
 * @param {number} position Character offset into the original text.
 * @param {CodeRange[]} ranges Output of {@link findCodeRanges}.
 * @returns {boolean} `true` if the position lies inside a code span.
 */
export function isInsideCode(position, ranges) {
  return ranges.some(([start, end]) => position >= start && position < end);
}
