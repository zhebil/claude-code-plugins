import { githubIssueProvider } from "./github-issue.mjs";
import { githubRepoProvider } from "./github-repo.mjs";
import { jiraProvider } from "./jira.mjs";
import { sentryProvider } from "./sentry.mjs";

/**
 * @typedef {Object} CommandResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {(command: string, args: string[], options?: {cwd?: string, timeout?: number}) => Promise<CommandResult>} Runner
 */

/**
 * @typedef {Object} EnrichmentContext
 * @property {string} cwd Working directory passed by Claude Code.
 * @property {Runner} runner Subprocess runner. Providers MUST call this
 *   instead of spawning directly so unit tests can inject a fake.
 * @property {Object<string, Object>} state Per-provider scratch space,
 *   keyed by `provider.name`. `prepare()` writes here; `detect()` /
 *   `fetch()` read from here.
 * @property {() => boolean} budgetExceeded Returns `true` once the
 *   orchestrator's wall-clock budget has been exhausted. Long-running
 *   `fetch()` paths may consult this to bail early.
 * @property {(name: string) => Object} providerConfig Returns the
 *   provider's user config sub-object (always an object, possibly
 *   empty). Read provider-specific keys from here, e.g. `cli`.
 */

/**
 * @typedef {Object} Match
 * @property {string} id Stable, namespaced id (e.g. `github:owner/repo#1`).
 *   Used for dedup and the seen-cache.
 *   Provider-specific fields may follow.
 */

/**
 * @typedef {Object} Provider
 * @property {1} [apiVersion] Required for custom providers loaded via
 *   discovery (must be `1`). Built-ins skip this check.
 * @property {string} name Stable identifier; doubles as the key under
 *   `ctx.state` for this provider's scratch space.
 *
 * @property {(text: string, ctx: EnrichmentContext) => Promise<void>} [prepare]
 *   Optional pre-flight step. Called once per prompt before any
 *   `detect()`. Use it to do up-front async work (CLI lookups, config
 *   reads) and stash results under `ctx.state[provider.name]`.
 *   Implementations should be cheap when the prompt clearly doesn't
 *   reference this provider's domain.
 *
 * @property {(text: string, codeRanges: [number, number][], ctx: EnrichmentContext) => Match[]} detect
 *   Locate references in the prompt. Each match must have a stable `id`
 *   plus any provider-specific fields needed by `fetch`/`summarize`.
 *   Implementations MUST skip matches inside `codeRanges` so backticked
 *   text isn't enriched.
 *
 * @property {(match: Match, ctx: EnrichmentContext) => Promise<string|null>} fetch
 *   Look up the reference and return a markdown block. Return `null` to
 *   skip silently (CLI not installed, auth missing, 404, etc.).
 *
 * @property {(match: Match) => string} summarize Short human-readable
 *   label for the visible stderr summary line.
 */

/**
 * Registered providers, in detection order.
 *
 * To add a new provider (Confluence, GitLab, Linear, etc.):
 *   1. Create `providers/<name>.mjs` exporting an object satisfying
 *      the {@link Provider} contract.
 *   2. Append it to this array.
 *   3. Add a unit test in `test/unit/providers/<name>.test.mjs`.
 *
 * The orchestrator never imports a provider directly - everything flows
 * through this array, so neither the orchestrator nor `lib/` should grow
 * provider-specific knowledge.
 *
 * @type {Provider[]}
 */
export const providers = [
  githubIssueProvider,
  githubRepoProvider,
  jiraProvider,
  sentryProvider,
];
