import * as fs from "node:fs";
import * as path from "node:path";
import type { VaultConfig } from "./config.js";
import type { Vault } from "./vault.js";

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: Date;
}

interface ToolCall {
  tool: string;
  summary: string;
  timestamp: Date;
}

/** Tracks all Pi session activity for daily summaries */
export class SessionTracker {
  private startTime: Date;
  private conversation: ConversationTurn[] = [];
  private toolCalls: ToolCall[] = [];
  private filesRead: Set<string> = new Set();
  private filesWritten: Set<string> = new Set();
  private filesEdited: Set<string> = new Set();
  private bashCommands: string[] = [];

  constructor() {
    this.startTime = new Date();
  }

  /** Record a user prompt */
  trackPrompt(text: string): void {
    const trimmed = text.trim();
    if (trimmed) {
      this.conversation.push({
        role: "user",
        text: trimmed,
        timestamp: new Date(),
      });
    }
  }

  /** Record an assistant response */
  trackAssistantResponse(text: string): void {
    const trimmed = text.trim();
    if (trimmed) {
      this.conversation.push({
        role: "assistant",
        text: trimmed,
        timestamp: new Date(),
      });
    }
  }

  /** Record any tool call from Pi */
  trackToolCall(toolName: string, input: Record<string, any>): void {
    const summary = summarizeToolCall(toolName, input);
    this.toolCalls.push({ tool: toolName, summary, timestamp: new Date() });

    switch (toolName) {
      case "read":
        if (input.file_path || input.path) this.filesRead.add(input.file_path || input.path);
        break;
      case "write":
        if (input.file_path || input.path) this.filesWritten.add(input.file_path || input.path);
        break;
      case "edit":
        if (input.file_path || input.path) this.filesEdited.add(input.file_path || input.path);
        break;
      case "bash":
        if (input.command) {
          const cmd = input.command.length > 120
            ? input.command.slice(0, 120) + "..."
            : input.command;
          this.bashCommands.push(cmd);
        }
        break;
      case "vault_read":
        if (input.path) this.filesRead.add(input.path);
        else if (input.name) this.filesRead.add(`[[${input.name}]]`);
        break;
      case "vault_write":
        if (input.path) this.filesWritten.add(input.path);
        break;
    }
  }

  hasActivity(): boolean {
    return this.conversation.length > 0 || this.toolCalls.length > 0;
  }

  /** Get session start time */
  getStartTime(): Date {
    return this.startTime;
  }

  /**
   * Build the full session context as text for LLM summarization.
   * Includes conversation, tool calls, and file activity.
   */
  toConversationText(): string {
    const sections: string[] = [];

    const time = formatTime(this.startTime);
    const endTime = this.conversation.length > 0
      ? formatTime(this.conversation[this.conversation.length - 1].timestamp)
      : time;
    sections.push(`Session: ${time} → ${endTime}`);
    sections.push("");

    // Conversation
    for (const turn of this.conversation) {
      const label = turn.role === "user" ? "User" : "Assistant";
      // Truncate very long turns to keep context manageable
      const text = turn.text.length > 2000
        ? turn.text.slice(0, 2000) + "\n...(truncated)"
        : turn.text;
      sections.push(`${label}: ${text}`);
      sections.push("");
    }

    // Tool calls
    if (this.toolCalls.length > 0) {
      sections.push("Tool calls:");
      for (const tc of this.toolCalls) {
        sections.push(`  - ${tc.summary}`);
      }
      sections.push("");
    }

    // Files
    const allFiles = new Set([...this.filesRead, ...this.filesEdited, ...this.filesWritten]);
    if (allFiles.size > 0) {
      sections.push("Files touched:");
      for (const f of this.filesRead) sections.push(`  - Read: ${f}`);
      for (const f of this.filesEdited) sections.push(`  - Edited: ${f}`);
      for (const f of this.filesWritten) sections.push(`  - Wrote: ${f}`);
      sections.push("");
    }

    // Bash commands
    if (this.bashCommands.length > 0) {
      sections.push("Shell commands:");
      for (const cmd of this.bashCommands) {
        sections.push(`  - ${cmd}`);
      }
    }

    return sections.join("\n");
  }
}

/** Build the LLM prompt for session summarization */
export function buildSummaryPrompt(conversationText: string, maxLength: number): string {
  return [
    "Summarize the following coding assistant session into a concise structured daily log entry.",
    `The summary must be at most ${maxLength} characters.`,
    "",
    "Use this exact structure:",
    "",
    "#### Overview",
    "One or two sentences: what was this session about at the highest level.",
    "",
    "#### Topics Discussed",
    "- Bullet list of the main topics / questions the user raised",
    "",
    "#### Actions Taken",
    "- Bullet list of concrete things that were done (files created/edited, commands run, configurations changed, etc.)",
    "",
    "#### Key Outcomes",
    "- Bullet list of important results, decisions, or conclusions reached",
    "",
    "#### Open Items",
    "- Bullet list of anything left unfinished, unresolved, or explicitly deferred. If nothing, write \"None.\"",
    "",
    "Rules:",
    "- Be concise but specific — include file names, function names, config keys when relevant",
    "- Do NOT include generic filler — every bullet should carry information",
    "- Do NOT wrap the output in code fences or add any preamble",
    "- Output ONLY the markdown sections above, nothing else",
    "",
    "<session>",
    conversationText,
    "</session>",
  ].join("\n");
}

/** Produce a one-line summary of a tool call */
function summarizeToolCall(toolName: string, input: Record<string, any>): string {
  switch (toolName) {
    case "read":
      return `Read \`${shortenPath(input.file_path || input.path || "")}\``;
    case "write":
      return `Wrote \`${shortenPath(input.file_path || input.path || "")}\``;
    case "edit":
      return `Edited \`${shortenPath(input.file_path || input.path || "")}\``;
    case "bash":
      return `Ran \`${(input.command || "").slice(0, 80)}\``;
    case "vault_search":
      return `Vault search: "${input.query || ""}"`;
    case "vault_tags":
      return input.tag ? `Vault tags: #${input.tag}` : "Listed vault tags";
    case "vault_backlinks":
      return `Vault backlinks: ${input.name || ""}`;
    case "vault_metadata":
      return `Vault metadata ${input.action || ""}: ${input.path || ""}`;
    case "vault_list":
      return `Listed vault: ${input.path || "/"}`;
    case "vault_read":
      return `Read vault note: ${input.path || input.name || ""}`;
    case "vault_write":
      return `Wrote vault note: ${input.path || ""}`;
    default:
      return `${toolName}`;
  }
}

function shortenPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath;
  return parts.slice(-2).join("/");
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Get today's daily file path */
export function getDailyFilePath(config: VaultConfig): string {
  const now = new Date();
  const filename = formatDateForFilename(now, config.dailySummary.filenameFormat);
  return `${config.dailySummary.folder}/${filename}.md`;
}

/** Append a pre-generated summary entry to the daily file */
export function appendSessionSummary(
  vault: Vault,
  config: VaultConfig,
  heading: string,
  summaryBody: string
): void {
  const dailyPath = getDailyFilePath(config);
  const fullPath = vault.resolve(dailyPath);
  const dir = path.dirname(fullPath);

  fs.mkdirSync(dir, { recursive: true });

  // Enforce max length on the body
  let body = summaryBody;
  if (body.length > config.dailySummary.maxLength) {
    body = body.slice(0, config.dailySummary.maxLength - 20) + "\n\n*(truncated)*";
  }

  const entry = `### ${heading}\n\n${body}`;

  const footer = config.conventions.footer;
  const footerBlock = footer ? `\n---\n${footer}\n` : "";

  if (!fs.existsSync(fullPath)) {
    const header = buildDailyHeader(config);
    fs.writeFileSync(fullPath, header + entry + "\n" + footerBlock, "utf-8");
  } else {
    const content = fs.readFileSync(fullPath, "utf-8");

    if (footer && content.includes(footer)) {
      const footerIdx = content.lastIndexOf(footer);
      let insertIdx = footerIdx;
      const before = content.slice(0, footerIdx);
      const sepIdx = before.lastIndexOf("\n---\n");
      if (sepIdx >= 0) {
        insertIdx = sepIdx;
      }
      const updated =
        content.slice(0, insertIdx).trimEnd() +
        "\n\n" +
        entry +
        "\n" +
        content.slice(insertIdx);
      fs.writeFileSync(fullPath, updated, "utf-8");
    } else {
      fs.appendFileSync(fullPath, "\n" + entry + "\n", "utf-8");
    }
  }
}

function buildDailyHeader(config: VaultConfig): string {
  const now = new Date();
  if (config.metadata.style === "plaintext") {
    const dateStr = formatDateForFilename(now, config.metadata.dateFormat);
    const lines = [
      `${config.metadata.fields.created}: ${dateStr}`,
      `${config.metadata.fields.tags}: #daily`,
      `${config.metadata.fields.links}:`,
    ];
    return lines.join("\n") + "\n\n---\n\n";
  }

  const dateStr = formatDateForFilename(now, config.metadata.dateFormat);
  return `---\ntags:\n  - daily\ncreated: ${dateStr}\n---\n\n`;
}

function formatDateForFilename(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return format
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/YY/g, String(date.getFullYear()).slice(2))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/DD/g, pad(date.getDate()))
    .replace(/HH/g, pad(date.getHours()))
    .replace(/mm/g, pad(date.getMinutes()))
    .replace(/ss/g, pad(date.getSeconds()));
}
