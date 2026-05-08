/**
 * Recursively render an Atlassian Document Format (ADF) node tree to
 * markdown. Handles the subset Jira returns from `acli jira workitem view
 * --json`: paragraphs, headings, lists, code blocks, tables, mentions,
 * status pills, dates, marks (bold/italic/code/link), etc.
 *
 * Unknown node types fall through to rendering their children, which is
 * usually right (the parent is a layout container) and degrades gracefully
 * when Atlassian adds new node types we haven't seen.
 *
 * @param {*} node ADF node, child array, string, or `null`.
 * @returns {string} Markdown text. Trailing whitespace is left to the caller.
 */
function renderAdfNode(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderAdfNode).join("");

  const renderChildren = () =>
    Array.isArray(node.content) ? node.content.map(renderAdfNode).join("") : "";

  switch (node.type) {
    case "doc":
      return renderChildren().trim();
    case "paragraph":
      return `${renderChildren()}\n\n`;
    case "heading": {
      const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);
      return `${"#".repeat(level)} ${renderChildren()}\n\n`;
    }
    case "hardBreak":
      return "  \n";
    case "rule":
      return "\n---\n\n";
    case "bulletList":
    case "orderedList": {
      const items = Array.isArray(node.content) ? node.content : [];
      const ordered = node.type === "orderedList";
      return (
        items
          .map((item, i) => {
            const marker = ordered ? `${i + 1}.` : "-";
            const body = renderAdfNode(item).trim();
            return body
              .split("\n")
              .map((line, idx) => (idx === 0 ? `${marker} ${line}` : `  ${line}`))
              .join("\n");
          })
          .join("\n") + "\n\n"
      );
    }
    case "listItem":
      return renderChildren();
    case "codeBlock":
      return `\n\`\`\`${node.attrs?.language ?? ""}\n${renderChildren()}\n\`\`\`\n\n`;
    case "blockquote":
      return (
        renderChildren()
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n\n"
      );
    case "panel": {
      const kind = node.attrs?.panelType ?? "info";
      return (
        `> **[${kind}]**\n` +
        renderChildren()
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") +
        "\n\n"
      );
    }
    case "mention":
      return `@${node.attrs?.text ?? node.attrs?.displayName ?? node.attrs?.id ?? ""}`;
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "status":
      return `[${node.attrs?.text ?? ""}]`;
    case "date":
      return node.attrs?.timestamp
        ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10)
        : "";
    case "inlineCard":
    case "blockCard":
      return node.attrs?.url ? `<${node.attrs.url}>` : "";
    case "table": {
      const rows = Array.isArray(node.content) ? node.content : [];
      if (!rows.length) return "";
      const rendered = rows.map((row) => {
        const cells = Array.isArray(row.content) ? row.content : [];
        return cells
          .map((cell) => renderAdfNode(cell).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|"))
          .join(" | ");
      });
      const header = rendered[0] ?? "";
      const sep = header.split("|").map(() => "---").join(" | ");
      return (
        `| ${rendered.join(" |\n| ")} |\n`.replace(`| ${header} |`, `| ${header} |\n| ${sep} |`) +
        "\n"
      );
    }
    case "tableRow":
    case "tableCell":
    case "tableHeader":
      return renderChildren();
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
    default: {
      // Unknown node type. If it has render-able children, fall through to
      // those (handles new wrapper node types Atlassian may add). Otherwise
      // surface it as a JSON code block so the user can still see what
      // shipped, even if we don't know how to format it.
      const rendered = renderChildren();
      if (rendered.trim()) return rendered;
      return `\n\`\`\`json\n${JSON.stringify(node, null, 2)}\n\`\`\`\n\n`;
    }
  }
}

/**
 * Convert a Jira description field to markdown. Accepts either a plain
 * string (legacy Jira REST shape) or an ADF document object. Collapses
 * runs of 3+ blank lines to keep output compact.
 *
 * @param {string | Object | null | undefined} description
 * @returns {string} Trimmed markdown, or `""` when input is empty/unknown.
 */
export function descriptionToMarkdown(description) {
  if (description == null) return "";
  if (typeof description === "string") return description.trim();
  if (typeof description === "object" && description.type) {
    return renderAdfNode(description).replace(/\n{3,}/g, "\n\n").trim();
  }
  return "";
}
