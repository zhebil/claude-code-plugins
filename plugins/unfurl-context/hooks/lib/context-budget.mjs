/**
 * Claude Code's cap on a hook's `additionalContext`. A longer value is saved
 * to a file and Claude only sees the path plus a 2,000-char preview, so the
 * whole enrichment has to fit under it.
 */
export const CONTEXT_CHAR_LIMIT = 10_000;

/** Below this much room a partial block is more noise than help; drop it instead. */
export const MIN_PARTIAL_BLOCK_CHARS = 500;

export const BLOCK_TRUNCATION_NOTE = "...(block truncated to fit the hook context limit)";

/**
 * @typedef {Object} FittedBlock
 * @property {string} text The block, unchanged or cut down to fit.
 * @property {boolean} truncated True when `text` was cut.
 */

/**
 * Fit a provider block into `room` chars. A block that fits is returned
 * unchanged. One that doesn't is cut, at a line boundary when one is close
 * enough, and gets a truncation note. Returns `null` when `room` is too small
 * for a useful partial block.
 *
 * @param {string} block
 * @param {number} room
 * @returns {FittedBlock|null}
 */
export function fitBlock(block, room) {
  if (block.length <= room) return { text: block, truncated: false };
  if (room < MIN_PARTIAL_BLOCK_CHARS) return null;
  const max = room - BLOCK_TRUNCATION_NOTE.length - 1;
  const lineEnd = block.lastIndexOf("\n", max);
  const cut = lineEnd >= max / 2 ? lineEnd : max;
  return { text: `${block.slice(0, cut)}\n${BLOCK_TRUNCATION_NOTE}`, truncated: true };
}
