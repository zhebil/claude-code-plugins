---
name: configure-auto-enrich
description: Explain the auto-enrich plugin to the user and show them how it's currently configured + what they can change. Use ONLY when the user explicitly invokes `/auto-enrich:configure-auto-enrich` or asks to set up / configure / inspect / troubleshoot auto-enrich. Do NOT auto-trigger from generic mentions of GitHub, GitLab, Jira, Sentry, or "context enrichment".
user-invocable: true
disable-model-invocation: true
---

# auto-enrich: explain + configure

User-invoked only. Don't run as a side effect of unrelated work. If the user mentions Jira / GitHub / GitLab / Sentry without asking to configure auto-enrich, ignore this skill.

## What this skill does

Explain to the user what auto-enrich is, gather the current state in one pass (parallel CLI + auth + config checks), present a concise summary of "what's on, what's off, what you can change", and then act on whatever the user actually wants. **Don't walk through numbered steps. Don't ask the user permission between every check. Don't re-prompt for things you can detect.**

The user already triggered the skill because they want information. Lead with the explanation and the current state, not with questions.

## The flow

### 1. Explain the plugin (short)

Open with a single tight paragraph. Cover:

- **What it does**: when the user submits a prompt mentioning a GitHub PR/issue/repo/file, GitLab issue/MR/project/file, Jira ticket, or Sentry issue, the plugin runs *before* Claude reads the prompt and prepends a compact markdown summary of that reference fetched via local CLIs (`gh`, `glab`, `acli` or `jira`, `sentry`). GitHub file URLs (`/blob/`, `/raw/`, `raw.githubusercontent.com`) and GitLab file URLs (`/-/blob/`, `/-/raw/`) embed the file contents, with optional line anchors for slicing.
- **Why it needs CLI auth**: the plugin doesn't store credentials. It just runs the CLIs as the user, so the CLIs need to be logged in to GitHub / GitLab / Atlassian / Sentry on their own. There's nothing to "configure" auth-wise inside the plugin.
- **Code blocks are skipped**: refs inside backticks or fenced blocks are never enriched.
- **Each ref is enriched once per session** (dedup state in `$CLAUDE_PLUGIN_DATA/seen.json`, preserved across `/compact`).

Keep this to roughly 4-6 lines. Don't reproduce the README.

### 2. Gather current state in ONE parallel batch

Without asking, run the install + auth + config checks at the same time. Use a single tool message with parallel `Bash` calls. Don't do them sequentially and don't pause to confirm.

The checks:

- `command -v gh && gh auth status 2>&1 | head -8`
- `command -v glab && glab auth status 2>&1 | head -8`
- `command -v acli && acli jira workitem search --jql 'assignee = currentUser()' --limit 1 2>&1 | head -3`
- `command -v jira && jira me 2>&1 | head -3`
- `command -v sentry && sentry org list --json 2>&1 | head -3`
- `cat "${CLAUDE_PLUGIN_DATA:-$HOME/.claude}/config.json" 2>/dev/null || cat "$HOME/.claude/auto-enrich.json" 2>/dev/null || echo "(no config file - defaults apply)"`

Treat "command not found" / non-zero exit as "not installed/authed" and move on; do not block on a missing CLI.

If `command -v` returns empty in the Claude Code subshell, also try `zsh -lc 'command -v <bin>'` once for that CLI - PATH in non-interactive shells often misses `~/.local/bin` and friends, and this catches the case where the user has the CLI but the default Bash tool environment doesn't see it.

### 3. Present current state as a single summary

After the parallel batch returns, render a small table or bulleted summary that the user can read at a glance. Include:

- Each built-in provider (`github-issue`, `github-file`, `github-repo`, `gitlab-issue`, `gitlab-file`, `gitlab-repo`, `jira`, `sentry`) and whether it's currently enabled (default = on, disabled only if `config.json` says so).
- The CLI each provider needs, and whether that CLI is installed + authed.
- For Jira specifically, which backend is selected (`acli` default, or `jira-cli`).
- Where the config file lives, and whether one exists right now.

Then, in the *same* message, list what the user can change:

- Toggle any provider on/off.
- Switch the Jira backend between `acli` and `jira-cli`.
- Add a custom provider (offer briefly, see step 5).
- Add a project to `trustedProjects` (only if they ask - it's security-sensitive, see step 6).

End with a single open question like: **"Anything you want to change, or are the defaults fine?"** - one question, not a step-by-step interview.

### 4. Act on what the user asks for

Only edit the config file when the user names a specific change. Rules:

- Resolve the path from `$CLAUDE_PLUGIN_DATA/config.json`, falling back to `~/.claude/auto-enrich.json` only if the env var is unset. Inside Claude Code the env var is set, so prefer that path. (Note: the per-plugin data dir is typically `~/.claude/plugins/data/auto-enrich-<source>/` - resolve it via the env var rather than hardcoding.)
- Show the diff (current file vs proposed file) before writing.
- Use `mkdir -p` for the parent dir if missing.
- Only write `{ "enabled": false }` for providers the user explicitly turned off. Leave defaults implicit - don't write `"enabled": true` everywhere.
- **If the user wants pure defaults back, delete the config file** rather than writing one full of `true`s. Less is more.
- After writing or deleting, `cat` the file (or note its absence) so the user can verify.

The config schema, for reference:

```jsonc
{
  "providers": {
    "github-issue": { "enabled": true },
    "github-file":  { "enabled": true },
    "github-repo":  { "enabled": true },
    "gitlab-issue": { "enabled": true },
    "gitlab-file":  { "enabled": true },
    "gitlab-repo":  { "enabled": true },
    "jira":         { "enabled": true, "cli": "acli" }, // "acli" | "jira-cli"
    "sentry":       { "enabled": true }
  },
  "trustedProjects": []
}
```

Defaults when keys are missing: every provider on, `jira.cli` = `"acli"`, no trusted projects.

**Per-project overrides**: dropping a config at `<projectRoot>/.claude/auto-enrich.json` overrides the global config when working inside that repo. Useful for "disable Jira just in this repo" or "use jira-cli here, acli everywhere else". Merge granularity is one level inside `providers.<name>` - a project file with `{ "providers": { "jira": { "enabled": false } } }` does NOT wipe out the global `cli` setting; both keys coexist with project values winning on overlap. **`trustedProjects` is silently ignored when set in a project file** - a repo cannot grant itself custom-provider execution trust. When a user asks for a per-repo change, prefer writing the project file over editing the global one.

### 5. Custom providers (only if the user asks)

If the user says they want to add support for something not built-in (Linear, Shortcut, Asana, an internal tracker, etc.):

1. Point them at `custom-provider-example.mjs` next to this SKILL.md - a runnable, well-commented Linear-issue example covering every contract field (`apiVersion`, `name`, `prepare`, `detect`, `fetch`, `summarize`, config reading, code-range filtering, error handling).
2. Have them copy it to `~/.claude/auto-enrich/providers/<name>.provider.mjs`. The `.provider.mjs` suffix is required - other files in that directory are ignored silently.
3. Explain that they need to **start a new Claude Code session** for the new provider to take effect (`/exit` then `claude` again). `/reload-plugins` does NOT re-run `SessionStart`, so it won't pick up new or edited provider files.
4. After restart, `cat $CLAUDE_PLUGIN_DATA/discovery.json` to confirm validation passed and the provider is listed.
5. **Mention upstream as an option, once**: if the tracker is a public product others might use (Linear, Shortcut, Bitbucket, Asana, etc. - GitHub, GitLab, Jira, and Sentry are already built in), you can note that <https://github.com/zhebil/claude-code-plugins> takes PRs for new built-ins, and that the contract + test patterns to follow live in `plugins/auto-enrich/docs/custom-providers.md` and `plugins/auto-enrich/test/`. Phrase it as a possibility, not a recommendation - say it once and drop it. Don't characterize where the provider "belongs"; the user knows their own situation. Skip this entirely for clearly internal/proprietary trackers.

For the full contract spec (validation rules, lifecycle, EnrichmentContext fields, replacing a built-in), point at `plugins/auto-enrich/docs/custom-providers.md`.

### 6. Project-level providers (only if the user asks, and only with a warning)

This is security-sensitive. Don't bring it up unprompted. If the user asks about it:

> Adding a path to `trustedProjects` grants that repository execute-on-session-start privileges. Every `*.provider.mjs` checked into `<repo>/.claude/auto-enrich/providers/` - including any added by future commits or merged PRs - will be `import()`-ed in the hook's Node process, with access to your working tree, env, and any tokens `gh` / `glab` / `acli` / `sentry` can reach. **Trust only repos whose contributor list is fully under your control.**

If they still want it, add the absolute project path to `trustedProjects` in the **global** config. Match is exact - no glob, no prefix walk. An in-repo `config.json` cannot grant itself trust. Resolution order: built-ins > global custom > project custom; name collisions are rejected with a stderr warning.

## Anti-patterns to avoid

These are the failure modes that came up in the previous version of this skill - don't repeat them:

- **Don't lead with "which sources do you want?"** The user just invoked a config skill; they expect an explanation and the current state, not an intake form. Front-load the explain + detect, ask questions only when something genuinely needs the user's input.
- **Don't run install/auth checks one at a time with confirmation in between.** They're independent and read-only - run them all in a single parallel batch.
- **Don't propose a smoke test as a default step.** The user can ask for one if they want it. Most of the time the parallel state-gathering already reveals whether things work.
- **Don't ask "do you also want a custom-provider walkthrough?" preemptively.** Mention custom providers as one of the available knobs in the summary, then drop it. Only walk through if asked.
- **Don't write `{"enabled": true}` for providers that are already on by default.** Empty config = defaults. Smaller diffs = clearer intent.
- **Don't re-ask things you already detected.** If `command -v acli` returned a path, don't ask "do you have acli installed?" - just report it as installed.

## Notes for future invocations

- This skill is idempotent. The user can re-run it any time to inspect or change settings; nothing here is destructive without explicit confirmation.
- Don't edit `settings.json`, `hooks.json`, or any plugin source code from this skill. Scope is: explanation, install/auth checks, the `auto-enrich` config file, and (optionally) helping drop a provider file.
- Debugging hooks the user might want: `cat $CLAUDE_PLUGIN_DATA/discovery.json` (which custom providers loaded), `cat $CLAUDE_PLUGIN_DATA/seen.json` (per-session dedup cache + post-compact stash), and stderr `auto-enrich:` lines (validation/runtime warnings).
