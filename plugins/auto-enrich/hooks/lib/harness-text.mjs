/**
 * Tags Claude Code wraps around text it injects into the prompt stream on its
 * own: background task results, reminders, local command output, messages
 * from other sessions, teammates and channels, and scheduled wakeups.
 * UserPromptSubmit fires for those turns too, and the payload carries no
 * field that tells them apart from typed input, so the tags are the signal.
 */
const HARNESS_TAGS = [
  "task-notification",
  "system-reminder",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "user-prompt-submit-hook",
  "teammate-message",
  "cross-session-message",
  "channel",
  "wake",
  "artifact-room-event",
];

/**
 * A harness block opens at the start of a line and runs to its matching
 * closing tag, or to the end of the text when the closing tag is missing.
 */
const HARNESS_BLOCK_PATTERN = new RegExp(
  `^<(${HARNESS_TAGS.join("|")})(?:\\s[^>\\n]*)?>[\\s\\S]*?(?:</\\1>|$(?![\\s\\S]))`,
  "gm",
);

/**
 * Remove every harness-injected block from a submitted prompt, leaving only
 * what the user typed or pasted. A prompt made entirely of harness blocks
 * (e.g. a background subagent reporting back) comes back blank.
 *
 * @param {string} prompt Raw `prompt` field from the UserPromptSubmit payload.
 * @returns {string}
 */
export function stripHarnessBlocks(prompt) {
  return prompt.replace(HARNESS_BLOCK_PATTERN, "");
}
