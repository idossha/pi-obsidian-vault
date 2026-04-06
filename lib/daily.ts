import * as fs from "node:fs";
import * as path from "node:path";
import type { VaultConfig } from "./config.js";
import type { Vault } from "./vault.js";

interface ToolCall {
  tool: string;
  summary: string;
  timestamp: Date;
}

/** Tracks all Pi session activity for daily summaries */
export class SessionTracker {
  private startTime: Date;
  private prompts: string[] = [];
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
    if (trimmed) this.prompts.push(trimmed);
  }

  /** Record any tool call from Pi */
  trackToolCall(toolName: string, input: Record<string, any>): void {
    const summary = summarizeToolCall(toolName, input);
    this.toolCalls.push({ tool: toolName, summary, timestamp: new Date() });

    // Also track specific categories for the summary
    switch (toolName) {
      case "read":
        if (input.file_path) this.filesRead.add(input.file_path);
        break;
      case "write":
        if (input.file_path) this.filesWritten.add(input.file_path);
        break;
      case "edit":
        if (input.file_path) this.filesEdited.add(input.file_path);
        break;
      case "bash":
        if (input.command) {
          // Truncate long commands
          const cmd = input.command.length > 100
            ? input.command.slice(0, 100) + "..."
            : input.command;
          this.bashCommands.push(cmd);
        }
        break;
      // Vault tools
      case "vault_read":
        if (input.path) this.filesRead.add(input.path);
        else if (input.name) this.filesRead.add(`[[${input.name}]]`);
        break;
      case "vault_write":
        if (input.path) this.filesWritten.add(input.path);
        break;
      case "vault_search":
      case "vault_tags":
      case "vault_backlinks":
      case "vault_metadata":
      case "vault_list":
        // Already captured in toolCalls
        break;
    }
  }

  hasActivity(): boolean {
    return this.prompts.length > 0 || this.toolCalls.length > 0;
  }

  /** Format the session as a markdown section */
  toMarkdown(): string {
    const time = formatTime(this.startTime);
    // Use first prompt as the session topic
    const topic = this.prompts.length > 0
      ? this.prompts[0].split("\n")[0].slice(0, 80)
      : "Pi session";
    const heading = `### ${time} — ${topic}`;
    const lines: string[] = [heading];

    // Conversation summary
    if (this.prompts.length > 1) {
      lines.push(`- ${this.prompts.length} prompts in conversation`);
    }

    // Files touched
    if (this.filesRead.size > 0) {
      const items = [...this.filesRead];
      if (items.length <= 5) {
        lines.push(...items.map((f) => `- Read: \`${shortenPath(f)}\``));
      } else {
        lines.push(...items.slice(0, 3).map((f) => `- Read: \`${shortenPath(f)}\``));
        lines.push(`- ... and ${items.length - 3} more files read`);
      }
    }

    if (this.filesEdited.size > 0) {
      lines.push(...[...this.filesEdited].map((f) => `- Edited: \`${shortenPath(f)}\``));
    }

    if (this.filesWritten.size > 0) {
      lines.push(...[...this.filesWritten].map((f) => `- Wrote: \`${shortenPath(f)}\``));
    }

    // Bash commands (condensed)
    if (this.bashCommands.length > 0) {
      if (this.bashCommands.length <= 3) {
        lines.push(...this.bashCommands.map((c) => `- Ran: \`${c}\``));
      } else {
        lines.push(...this.bashCommands.slice(0, 2).map((c) => `- Ran: \`${c}\``));
        lines.push(`- ... and ${this.bashCommands.length - 2} more commands`);
      }
    }

    // Other notable tool calls (vault-specific, grep, find, etc.)
    const otherTools = this.toolCalls.filter(
      (tc) => !["read", "write", "edit", "bash", "vault_read", "vault_write"].includes(tc.tool)
    );
    if (otherTools.length > 0) {
      const toolSummary = new Map<string, number>();
      for (const tc of otherTools) {
        toolSummary.set(tc.tool, (toolSummary.get(tc.tool) || 0) + 1);
      }
      for (const [tool, count] of toolSummary) {
        // Show first call's summary for single-use tools
        if (count === 1) {
          const call = otherTools.find((tc) => tc.tool === tool)!;
          lines.push(`- ${call.summary}`);
        } else {
          lines.push(`- ${tool} (${count}x)`);
        }
      }
    }

    // Follow-up topics (subsequent prompts, condensed)
    if (this.prompts.length > 1) {
      lines.push("");
      lines.push("**Topics discussed:**");
      // Deduplicate and show unique first lines
      const seen = new Set<string>();
      for (const p of this.prompts) {
        const firstLine = p.split("\n")[0].slice(0, 100);
        if (!seen.has(firstLine)) {
          seen.add(firstLine);
          lines.push(`- ${firstLine}`);
        }
      }
    }

    return lines.join("\n");
  }
}

/** Produce a one-line summary of a tool call */
function summarizeToolCall(toolName: string, input: Record<string, any>): string {
  switch (toolName) {
    case "read":
      return `Read \`${shortenPath(input.file_path || "")}\``;
    case "write":
      return `Wrote \`${shortenPath(input.file_path || "")}\``;
    case "edit":
      return `Edited \`${shortenPath(input.file_path || "")}\``;
    case "bash":
      return `Ran \`${(input.command || "").slice(0, 60)}\``;
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
    case "grep":
    case "find":
    case "ls":
      return `${toolName}: ${input.pattern || input.path || ""}`;
    default:
      return `${toolName}`;
  }
}

function shortenPath(filePath: string): string {
  // Show just filename or last 2 path segments
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath;
  return parts.slice(-2).join("/");
}

/** Get today's daily file path */
export function getDailyFilePath(config: VaultConfig): string {
  const now = new Date();
  const filename = formatDateForFilename(now, config.dailySummary.filenameFormat);
  return `${config.dailySummary.folder}/${filename}.md`;
}

/** Append a session summary to the daily file, creating it if needed */
export function appendSessionSummary(
  vault: Vault,
  config: VaultConfig,
  tracker: SessionTracker
): void {
  if (!tracker.hasActivity()) return;

  const dailyPath = getDailyFilePath(config);
  const fullPath = vault.resolve(dailyPath);
  const dir = path.dirname(fullPath);

  fs.mkdirSync(dir, { recursive: true });

  const footer = config.conventions.footer;
  const footerBlock = footer ? `\n---\n${footer}\n` : "";
  const entry = tracker.toMarkdown();

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

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
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
