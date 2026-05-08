#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_README_CHARS = 12000;
const MAX_MATCHES = 8;
const FETCH_TIMEOUT_MS = 20000;
const REPO_TIMEOUT_MS = 5000;

function getCodeRanges(text) {
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

function inCode(pos, ranges) {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}

function findMatches(text, defaultRepo) {
  const ranges = getCodeRanges(text);
  const out = [];
  const seenIds = new Set();
  const push = (m) => {
    if (seenIds.has(m.id)) return;
    seenIds.add(m.id);
    out.push(m);
  };

  for (const m of text.matchAll(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/g)) {
    if (inCode(m.index, ranges)) continue;
    const [, owner, repo, number] = m;
    push({ kind: "github", id: `gh:${owner}/${repo}#${number}`, owner, repo, number });
  }

  for (const m of text.matchAll(/(?<![\w/-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g)) {
    if (inCode(m.index, ranges)) continue;
    const [, owner, repo, number] = m;
    push({ kind: "github", id: `gh:${owner}/${repo}#${number}`, owner, repo, number });
  }

  if (defaultRepo) {
    const [owner, repo] = defaultRepo.split("/");
    for (const m of text.matchAll(/(?<![\w/#-])#(\d+)\b/g)) {
      if (inCode(m.index, ranges)) continue;
      const [, number] = m;
      push({ kind: "github", id: `gh:${owner}/${repo}#${number}`, owner, repo, number });
    }
  }

  for (const m of text.matchAll(/https?:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/g)) {
    if (inCode(m.index, ranges)) continue;
    push({ kind: "jira", id: `jira:${m[1]}`, key: m[1] });
  }

  for (const m of text.matchAll(/(?<![\w-])([A-Z][A-Z0-9]+-\d+)(?![\w-])/g)) {
    if (inCode(m.index, ranges)) continue;
    push({ kind: "jira", id: `jira:${m[1]}`, key: m[1] });
  }

  for (const m of text.matchAll(/https?:\/\/(?:[\w.-]+\.)?sentry\.io\/(?:organizations\/[\w.-]+\/)?issues\/(\d+)/g)) {
    if (inCode(m.index, ranges)) continue;
    push({ kind: "sentry", id: `sentry:${m[1]}`, issueId: m[1] });
  }

  const reservedRepoPaths = new Set([
    "pull",
    "issues",
    "pulls",
    "actions",
    "discussions",
    "releases",
    "wiki",
    "settings",
    "security",
    "network",
    "pulse",
    "graphs",
    "compare",
  ]);
  for (const m of text.matchAll(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(\w+)[\w./-]*)?(?=[\s)\]>,]|$)/g)) {
    if (inCode(m.index, ranges)) continue;
    const [, owner, repo, sub] = m;
    if (sub && reservedRepoPaths.has(sub)) continue;
    push({ kind: "githubRepo", id: `gh-repo:${owner}/${repo}`, owner, repo });
  }

  return out;
}

function run(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeout = options.timeout || FETCH_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeout);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || String(error) });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
  });
}

async function getDefaultRepo(cwd) {
  const r = await run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    cwd,
    timeout: REPO_TIMEOUT_MS,
  });
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

function jsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickStr(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "object" && (v.name || v.displayName || v.value)) return v.displayName ?? v.name ?? v.value;
  }
  return "";
}

function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function adfToMarkdown(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToMarkdown).join("");
  const children = () => (Array.isArray(node.content) ? node.content.map(adfToMarkdown).join("") : "");

  switch (node.type) {
    case "doc":
      return children().trim();
    case "paragraph":
      return `${children()}\n\n`;
    case "heading": {
      const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);
      return `${"#".repeat(level)} ${children()}\n\n`;
    }
    case "hardBreak":
      return "  \n";
    case "rule":
      return "\n---\n\n";
    case "bulletList":
    case "orderedList": {
      const items = Array.isArray(node.content) ? node.content : [];
      const ordered = node.type === "orderedList";
      return items.map((item, i) => {
        const marker = ordered ? `${i + 1}.` : "-";
        const body = adfToMarkdown(item).trim();
        return body.split("\n").map((line, idx) => (idx === 0 ? `${marker} ${line}` : `  ${line}`)).join("\n");
      }).join("\n") + "\n\n";
    }
    case "listItem":
      return children();
    case "codeBlock":
      return `\n\`\`\`${node.attrs?.language ?? ""}\n${children()}\n\`\`\`\n\n`;
    case "blockquote":
      return children().trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    case "panel": {
      const kind = node.attrs?.panelType ?? "info";
      return `> **[${kind}]**\n` + children().trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    }
    case "mention":
      return `@${node.attrs?.text ?? node.attrs?.displayName ?? node.attrs?.id ?? ""}`;
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "status":
      return `[${node.attrs?.text ?? ""}]`;
    case "date":
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "inlineCard":
    case "blockCard":
      return node.attrs?.url ? `<${node.attrs.url}>` : "";
    case "table": {
      const rows = Array.isArray(node.content) ? node.content : [];
      if (!rows.length) return "";
      const rendered = rows.map((row) => {
        const cells = Array.isArray(row.content) ? row.content : [];
        return cells.map((cell) => adfToMarkdown(cell).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")).join(" | ");
      });
      const header = rendered[0] ?? "";
      const sep = header.split("|").map(() => "---").join(" | ");
      return `| ${rendered.join(" |\n| ")} |\n`.replace(`| ${header} |`, `| ${header} |\n| ${sep} |`) + "\n";
    }
    case "tableRow":
    case "tableCell":
    case "tableHeader":
      return children();
    case "text": {
      let out = String(node.text ?? "");
      const marks = Array.isArray(node.marks) ? node.marks : [];
      for (const mark of marks) {
        switch (mark.type) {
          case "strong":
            out = `**${out}**`;
            break;
          case "em":
            out = `*${out}*`;
            break;
          case "code":
            out = `\`${out}\``;
            break;
          case "strike":
            out = `~~${out}~~`;
            break;
          case "link":
            out = mark.attrs?.href ? `[${out}](${mark.attrs.href})` : out;
            break;
        }
      }
      return out;
    }
    default:
      return children();
  }
}

function descriptionToMarkdown(description) {
  if (description == null) return "";
  if (typeof description === "string") return description.trim();
  if (typeof description === "object" && description.type) return adfToMarkdown(description).replace(/\n{3,}/g, "\n\n").trim();
  return "";
}

function formatGithub({ owner, repo, number, isPR, data, prExtra }) {
  const lines = [];
  const kind = isPR ? "PR" : "Issue";
  lines.push(`#### ${kind} ${owner}/${repo}#${number}: ${data.title ?? ""}`);
  if (data.html_url) lines.push(`- URL: ${data.html_url}`);
  const stateExtra = data.state === "closed" && data.state_reason ? ` (${data.state_reason})` : "";
  lines.push(`- State: ${data.state}${stateExtra}`);
  lines.push(`- Author: ${data.user?.login ?? "?"}`);
  if (data.labels?.length) lines.push(`- Labels: ${data.labels.map((label) => label.name).join(", ")}`);
  if (isPR && prExtra) {
    if (prExtra.headRefName && prExtra.baseRefName) lines.push(`- Branch: ${prExtra.headRefName} -> ${prExtra.baseRefName}`);
    if (prExtra.isDraft) lines.push("- Draft: yes");
    if (prExtra.reviewDecision) lines.push(`- Review: ${prExtra.reviewDecision}`);
    if (prExtra.mergeable) lines.push(`- Mergeable: ${prExtra.mergeable}`);
    const checks = prExtra.statusCheckRollup;
    if (Array.isArray(checks) && checks.length) {
      const failing = checks.filter((check) => {
        const state = String(check.conclusion ?? check.state ?? "").toUpperCase();
        return state && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state);
      }).length;
      lines.push(`- Checks: ${checks.length} total, ${failing} failing/pending`);
    }
  }
  const body = (isPR && prExtra ? prExtra.body : data.body) ?? "";
  if (String(body).trim()) {
    lines.push("", "**Body:**", String(body).trim());
  }
  lines.push("");
  const cmd = isPR ? `gh pr view ${number} --repo ${owner}/${repo} --comments` : `gh issue view ${number} --repo ${owner}/${repo} --comments`;
  lines.push(`Refetch with comments: \`${cmd}\``);
  return lines.join("\n");
}

function formatGithubRepo({ owner, repo, meta, readme }) {
  const lines = [];
  const desc = meta?.description ? `: ${meta.description}` : "";
  lines.push(`#### Repo ${owner}/${repo}${desc}`);
  if (meta?.html_url) lines.push(`- URL: ${meta.html_url}`);
  if (meta?.language) lines.push(`- Language: ${meta.language}`);
  if (meta?.default_branch) lines.push(`- Default branch: ${meta.default_branch}`);
  if (meta?.stargazers_count != null) lines.push(`- Stars: ${meta.stargazers_count}`);
  if (meta?.archived) lines.push("- Archived: yes");
  if (meta?.fork) lines.push("- Fork: yes");
  if (meta?.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION") lines.push(`- License: ${meta.license.spdx_id}`);
  const trimmed = readme.trim();
  if (trimmed) {
    const body = trimmed.length > MAX_README_CHARS ? `${trimmed.slice(0, MAX_README_CHARS)}\n\n...(README truncated, ${trimmed.length - MAX_README_CHARS} more chars)` : trimmed;
    lines.push("", "**README:**", body);
  }
  lines.push("", `Refetch full README: \`gh api repos/${owner}/${repo}/readme -H "Accept: application/vnd.github.raw"\``);
  return lines.join("\n");
}

function formatJira(key, raw) {
  const f = raw.fields ?? raw;
  const summary = pickStr(f.summary, raw.summary);
  const status = pickStr(f.status, raw.status);
  const type = pickStr(f.issuetype, f.type, raw.type);
  const priority = pickStr(f.priority, raw.priority);
  const assignee = pickStr(f.assignee, raw.assignee) || "unassigned";
  const reporter = pickStr(f.reporter, raw.reporter);
  const description = descriptionToMarkdown(f.description ?? raw.description);
  const url = raw.url ?? raw.self ?? "";
  const lines = [];
  lines.push(`#### Jira ${key}: ${summary}`);
  if (url) lines.push(`- URL: ${url}`);
  if (type) lines.push(`- Type: ${type}`);
  if (status) lines.push(`- Status: ${status}`);
  if (priority) lines.push(`- Priority: ${priority}`);
  lines.push(`- Assignee: ${assignee}`);
  if (reporter) lines.push(`- Reporter: ${reporter}`);
  if (description) lines.push("", "**Description:**", description);
  lines.push("", `Refetch with comments: \`acli jira workitem view ${key} --comments\``);
  return lines.join("\n");
}

const sentryInterestingTags = new Set([
  "environment",
  "release",
  "transaction",
  "url",
  "browser",
  "browser.name",
  "os",
  "os.name",
  "runtime",
  "runtime.name",
  "server_name",
  "handled",
  "level",
]);

function formatSentry(id, issue, event) {
  const lines = [];
  const title = issue.title ?? issue.metadata?.title ?? event?.title ?? "(no title)";
  lines.push(`#### Sentry issue ${id}: ${title}`);
  if (issue.permalink) lines.push(`- URL: ${issue.permalink}`);
  if (issue.shortId) lines.push(`- Short ID: ${issue.shortId}`);
  if (issue.project?.slug) lines.push(`- Project: ${issue.project.slug}`);
  if (issue.level) lines.push(`- Level: ${issue.level}`);
  if (issue.status) lines.push(`- Status: ${issue.status}`);
  if (issue.culprit) lines.push(`- Culprit: ${issue.culprit}`);
  if (issue.count != null) lines.push(`- Event count: ${issue.count}`);
  if (issue.userCount != null) lines.push(`- Users affected: ${issue.userCount}`);
  if (issue.firstSeen) lines.push(`- First seen: ${issue.firstSeen}`);
  if (issue.lastSeen) lines.push(`- Last seen: ${issue.lastSeen}`);
  const assignee = issue.assignedTo?.name ?? issue.assignedTo?.username ?? issue.assignedTo?.email;
  if (assignee) lines.push(`- Assignee: ${assignee}`);

  const topMessage = asText(issue.metadata?.value ?? issue.message);
  if (topMessage.trim()) lines.push("", "**Message:**", topMessage.trim());

  if (event) {
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const picked = tags.filter((tag) => sentryInterestingTags.has(tag.key));
    if (picked.length) {
      lines.push("", "**Tags:**");
      for (const tag of picked) lines.push(`- ${tag.key}: ${asText(tag.value)}`);
    }

    const entries = Array.isArray(event.entries) ? event.entries : [];
    const exc = entries.find((entry) => entry.type === "exception");
    const values = exc?.data?.values ?? [];
    if (values.length) {
      lines.push("", "**Exception:**");
      for (const value of values) {
        const head = value.module ? `${value.module}.${value.type ?? "Error"}` : value.type ?? "Error";
        const val = asText(value.value);
        lines.push(`- ${head}${val ? `: ${val}` : ""}`);
        const frames = value.stacktrace?.frames ?? [];
        const top = frames.slice(-10).reverse();
        if (top.length) {
          lines.push("", "```");
          for (const frame of top) {
            const loc = `${frame.filename ?? frame.module ?? frame.absPath ?? "?"}:${frame.lineNo ?? "?"}`;
            const fn = frame.function ? ` in ${frame.function}` : "";
            const flag = frame.inApp === false ? " [vendor]" : "";
            lines.push(`  at ${loc}${fn}${flag}`);
          }
          lines.push("```");
        }
      }
    } else {
      const msg = entries.find((entry) => entry.type === "message");
      const formatted = asText(msg?.data?.formatted ?? msg?.data?.message);
      if (formatted.trim() && formatted.trim() !== topMessage.trim()) lines.push("", "**Event message:**", formatted.trim());
    }

    if (event.eventID) lines.push("", `- Latest event ID: \`${event.eventID}\``);
  }

  lines.push("", `Refetch full latest event: \`sentry api /api/0/issues/${id}/events/latest/\`\nRefetch issue events: \`sentry api /api/0/issues/${id}/events/\``);
  return lines.join("\n");
}

async function fetchGithub(m, cwd) {
  const { owner, repo, number } = m;
  const r = await run("gh", ["api", `repos/${owner}/${repo}/issues/${number}`], { cwd });
  if (r.code !== 0) return null;
  const data = jsonParse(r.stdout);
  if (!data) return null;
  const isPR = !!data.pull_request;
  let prExtra = null;
  if (isPR) {
    const pr = await run("gh", [
      "pr",
      "view",
      number,
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "title,state,author,baseRefName,headRefName,body,url,reviewDecision,isDraft,mergeable,statusCheckRollup,labels",
    ], { cwd });
    if (pr.code === 0) prExtra = jsonParse(pr.stdout);
  }
  return formatGithub({ owner, repo, number, isPR, data, prExtra });
}

async function fetchGithubRepo(m, cwd) {
  const { owner, repo } = m;
  const metaR = await run("gh", ["api", `repos/${owner}/${repo}`], { cwd });
  const meta = metaR.code === 0 ? jsonParse(metaR.stdout) : null;
  const readmeR = await run("gh", ["api", `repos/${owner}/${repo}/readme`, "-H", "Accept: application/vnd.github.raw"], { cwd });
  const readme = readmeR.code === 0 ? readmeR.stdout : "";
  if (!meta && !readme.trim()) return null;
  return formatGithubRepo({ owner, repo, meta, readme });
}

async function fetchJira(m, cwd) {
  const r = await run("acli", ["jira", "workitem", "view", m.key, "--json"], { cwd });
  if (r.code !== 0) return null;
  const data = jsonParse(r.stdout);
  if (!data) return null;
  return formatJira(m.key, data);
}

async function fetchSentry(m, cwd) {
  const issueR = await run("sentry", ["api", `/api/0/issues/${m.issueId}/`], { cwd });
  if (issueR.code !== 0) return null;
  const issue = jsonParse(issueR.stdout);
  if (!issue) return null;
  let event = null;
  const eventR = await run("sentry", ["api", `/api/0/issues/${m.issueId}/events/latest/`], { cwd });
  if (eventR.code === 0) event = jsonParse(eventR.stdout);
  return formatSentry(m.issueId, issue, event);
}

function cachePath() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(process.env.HOME || process.cwd(), ".cache", "claude-auto-enrich");
  return join(base, "seen.json");
}

async function readSeen(sessionId) {
  try {
    const raw = await readFile(cachePath(), "utf8");
    const data = jsonParse(raw) || {};
    return { data, seen: new Set(Array.isArray(data[sessionId]) ? data[sessionId] : []) };
  } catch {
    return { data: {}, seen: new Set() };
  }
}

async function writeSeen(data, sessionId, seen) {
  const file = cachePath();
  data[sessionId] = [...seen].slice(-200);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

async function main() {
  const input = jsonParse(await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  })) || {};

  const text = input.user_prompt || input.prompt || "";
  if (!text.trim()) return;

  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "ephemeral";
  const needsRepo = /(?<![\w/#-])#\d+\b/.test(text);
  const defaultRepo = needsRepo ? await getDefaultRepo(cwd) : null;
  const matches = findMatches(text, defaultRepo).slice(0, MAX_MATCHES);
  if (!matches.length) return;

  const { data, seen } = await readSeen(sessionId);
  const fresh = matches.filter((m) => !seen.has(m.id));
  if (!fresh.length) return;

  const blocks = [];
  for (const m of fresh) {
    try {
      let block = null;
      if (m.kind === "github") block = await fetchGithub(m, cwd);
      else if (m.kind === "githubRepo") block = await fetchGithubRepo(m, cwd);
      else if (m.kind === "jira") block = await fetchJira(m, cwd);
      else if (m.kind === "sentry") block = await fetchSentry(m, cwd);
      if (block) {
        blocks.push(block);
        seen.add(m.id);
      }
    } catch {
    }
  }

  if (!blocks.length) return;
  await writeSeen(data, sessionId, seen);
  process.stdout.write(`### Auto-enriched context\n\n${blocks.join("\n\n")}`);
}

main().catch(() => process.exit(0));
