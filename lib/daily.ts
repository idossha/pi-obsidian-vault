import * as fs from "node:fs";
import * as path from "node:path";
import type { DailySummaryDetailLevel, VaultConfig } from "./config.js";
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

interface ToolResult {
  tool: string;
  summary: string;
  timestamp: Date;
  isError: boolean;
}

export interface SummaryUnit {
  id: string;
  text: string;
}

export interface SummaryChunk {
  index: number;
  total: number;
  units: SummaryUnit[];
  text: string;
  estimatedTokens: number;
}

export interface SummaryModelLimits {
  contextWindow?: number;
  maxTokens?: number;
}

export interface SummaryPlan {
  strategy: "single-pass" | "hierarchical";
  detailLevel: DailySummaryDetailLevel;
  sourceCharacters: number;
  sourceTokens: number;
  sourceUnits: number;
  chunkCount: number;
  contextWindow: number;
  modelMaxTokens: number;
  finalInputBudgetTokens: number;
  chunkInputBudgetTokens: number;
  finalOutputTokens: number;
  chunkOutputTokens: number;
}

export interface SessionSummaryStats {
  startTime: Date;
  endTime: Date;
  conversationTurns: number;
  toolCalls: number;
  filesRead: number;
  filesEdited: number;
  filesWritten: number;
  bashCommands: number;
  summaryUnits: number;
  characters: number;
  estimatedTokens: number;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;
const PROMPT_OVERHEAD_TOKENS = 1400;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MODEL_MAX_TOKENS = 4096;

const DETAIL_SETTINGS: Record<
  DailySummaryDetailLevel,
  { ratio: number; base: number; minOutput: number }
> = {
  concise: { ratio: 0.06, base: 350, minOutput: 600 },
  normal: { ratio: 0.10, base: 550, minOutput: 900 },
  detailed: { ratio: 0.16, base: 800, minOutput: 1200 },
};

/** Tracks Pi session activity for daily summaries. */
export class SessionTracker {
  private startTime: Date;
  private conversation: ConversationTurn[] = [];
  private toolCalls: ToolCall[] = [];
  private toolResults: ToolResult[] = [];
  private filesRead: Set<string> = new Set();
  private filesWritten: Set<string> = new Set();
  private filesEdited: Set<string> = new Set();
  private bashCommands: string[] = [];

  constructor() {
    this.startTime = new Date();
  }

  /** Record a user prompt. */
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

  /** Record an assistant response. */
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

  /** Record any tool call from Pi. */
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
        if (input.command) this.bashCommands.push(String(input.command));
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

  /** Record a tool result, including full textual result content when available. */
  trackToolResult(
    toolName: string,
    input: Record<string, any> | undefined,
    content: unknown,
    isError = false
  ): void {
    const summary = summarizeToolResult(toolName, input || {}, content, isError);
    this.toolResults.push({ tool: toolName, summary, timestamp: new Date(), isError });
  }

  hasActivity(): boolean {
    return this.conversation.length > 0 || this.toolCalls.length > 0 || this.toolResults.length > 0;
  }

  /** Get session start time. */
  getStartTime(): Date {
    return this.startTime;
  }

  /** Get counts and token estimates for status displays and summary planning. */
  getActivityStats(): SessionSummaryStats {
    const units = this.toSummaryUnits();
    const text = units.map((unit) => unit.text).join("\n\n");
    const lastTurn = this.conversation[this.conversation.length - 1];
    return {
      startTime: this.startTime,
      endTime: lastTurn?.timestamp ?? this.startTime,
      conversationTurns: this.conversation.length,
      toolCalls: this.toolCalls.length + this.toolResults.length,
      filesRead: this.filesRead.size,
      filesEdited: this.filesEdited.size,
      filesWritten: this.filesWritten.size,
      bashCommands: this.bashCommands.length,
      summaryUnits: units.length,
      characters: text.length,
      estimatedTokens: estimateTokens(text),
    };
  }

  /**
   * Build full session context as text for LLM summarization.
   *
   * This intentionally does not truncate turns, commands, or file lists. If the
   * content is too large for one model request, callers should use
   * `toSummaryUnits()` + `chunkSummaryUnits()` and summarize hierarchically.
   */
  toConversationText(): string {
    return this.toSummaryUnits().map((unit) => unit.text).join("\n\n");
  }

  /** Build atomic summary units. Chunking may split oversized units, but never drops content. */
  toSummaryUnits(): SummaryUnit[] {
    const units: SummaryUnit[] = [];
    const time = formatTime(this.startTime);
    const endTime = this.conversation.length > 0
      ? formatTime(this.conversation[this.conversation.length - 1].timestamp)
      : time;

    units.push({
      id: "session-metadata",
      text: [
        "# Session Metadata",
        `Start: ${time}`,
        `End: ${endTime}`,
        `Conversation turns: ${this.conversation.length}`,
        `Tool calls/results: ${this.toolCalls.length + this.toolResults.length}`,
      ].join("\n"),
    });

    for (let i = 0; i < this.conversation.length; i++) {
      const turn = this.conversation[i];
      const label = turn.role === "user" ? "User" : "Assistant";
      units.push({
        id: `conversation-${i + 1}-${turn.role}`,
        text: [`# Conversation ${i + 1} — ${label} (${formatTime(turn.timestamp)})`, turn.text].join("\n\n"),
      });
    }

    for (let i = 0; i < this.toolCalls.length; i++) {
      const tc = this.toolCalls[i];
      units.push({
        id: `tool-call-${i + 1}-${tc.tool}`,
        text: [`# Tool Call ${i + 1} — ${tc.tool} (${formatTime(tc.timestamp)})`, tc.summary].join("\n\n"),
      });
    }

    for (let i = 0; i < this.toolResults.length; i++) {
      const tr = this.toolResults[i];
      units.push({
        id: `tool-result-${i + 1}-${tr.tool}`,
        text: [`# Tool Result ${i + 1} — ${tr.tool}${tr.isError ? " (error)" : ""} (${formatTime(tr.timestamp)})`, tr.summary].join("\n\n"),
      });
    }

    const fileLines: string[] = [];
    for (const f of this.filesRead) fileLines.push(`- Read: ${f}`);
    for (const f of this.filesEdited) fileLines.push(`- Edited: ${f}`);
    for (const f of this.filesWritten) fileLines.push(`- Wrote: ${f}`);
    if (fileLines.length > 0) {
      units.push({
        id: "files-touched",
        text: ["# Files Touched", ...fileLines].join("\n"),
      });
    }

    if (this.bashCommands.length > 0) {
      units.push({
        id: "shell-commands",
        text: [
          "# Shell Commands",
          ...this.bashCommands.map((cmd, i) => `## Command ${i + 1}\n${cmd}`),
        ].join("\n\n"),
      });
    }

    return units;
  }
}

/** Estimate tokens without provider-specific tokenization. Conservative enough for chunk planning. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE));
}

/** Build an adaptive summary plan from source size and model limits. */
export function buildSummaryPlan(
  units: SummaryUnit[],
  model: SummaryModelLimits,
  detailLevel: DailySummaryDetailLevel = "normal"
): SummaryPlan {
  const contextWindow = positiveInteger(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  const modelMaxTokens = positiveInteger(model.maxTokens, DEFAULT_MODEL_MAX_TOKENS);
  const sourceText = formatSummaryUnits(units);
  const sourceTokens = estimateTokens(sourceText);
  const maxOutputTokens = Math.max(
    512,
    Math.min(modelMaxTokens, Math.floor(contextWindow * 0.35))
  );
  const finalOutputTokens = chooseOutputTokens(sourceTokens, detailLevel, maxOutputTokens);
  const finalInputBudgetTokens = computeInputBudget(contextWindow, finalOutputTokens);

  const representativeChunkTokens = Math.min(sourceTokens, finalInputBudgetTokens);
  const chunkOutputTokens = chooseOutputTokens(
    representativeChunkTokens,
    detailLevel,
    Math.max(512, Math.min(modelMaxTokens, Math.floor(contextWindow * 0.30)))
  );
  const chunkInputBudgetTokens = computeInputBudget(contextWindow, chunkOutputTokens);
  const chunkCount = chunkSummaryUnits(
    units,
    sourceTokens <= finalInputBudgetTokens ? finalInputBudgetTokens : chunkInputBudgetTokens
  ).length;

  return {
    strategy: chunkCount <= 1 ? "single-pass" : "hierarchical",
    detailLevel,
    sourceCharacters: sourceText.length,
    sourceTokens,
    sourceUnits: units.length,
    chunkCount,
    contextWindow,
    modelMaxTokens,
    finalInputBudgetTokens,
    chunkInputBudgetTokens,
    finalOutputTokens,
    chunkOutputTokens,
  };
}

/** Chunk summary units to fit a model input budget. Content is split, never discarded. */
export function chunkSummaryUnits(units: SummaryUnit[], inputBudgetTokens: number): SummaryChunk[] {
  const budget = Math.max(1, Math.floor(inputBudgetTokens));
  const expandedUnits = units.flatMap((unit) => splitOversizedUnit(unit, budget));
  const groups: SummaryUnit[][] = [];
  let current: SummaryUnit[] = [];

  for (const unit of expandedUnits) {
    const candidate = [...current, unit];
    const candidateTokens = estimateTokens(formatSummaryUnits(candidate));

    if (current.length > 0 && candidateTokens > budget) {
      groups.push(current);
      current = [unit];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) groups.push(current);

  return groups.map((group, i) => {
    const text = formatSummaryUnits(group);
    return {
      index: i + 1,
      total: groups.length,
      units: group,
      text,
      estimatedTokens: estimateTokens(text),
    };
  });
}

export function formatSummaryUnits(units: SummaryUnit[]): string {
  return units.map(formatSummaryUnit).join("\n\n");
}

function formatSummaryUnit(unit: SummaryUnit): string {
  return `<summary-unit id="${escapeAttribute(unit.id)}">\n${unit.text}\n</summary-unit>`;
}

/** Build the final LLM prompt for session summarization. */
export function buildFinalSummaryPrompt(
  sourceText: string,
  plan: SummaryPlan,
  sourceKind: "session-transcript" | "intermediate-summaries" = "session-transcript"
): string {
  return [
    "Transform the following coding assistant session context into an Obsidian daily-note entry that grows into a useful knowledge base.",
    "Do not use a fixed line or character limit. Adjust the level of detail to the amount of context and conversation history provided.",
    "The summary request is planned from context size and model limits; produce complete markdown and never end mid-sentence or mid-section.",
    densityHint(plan.sourceTokens, plan.detailLevel),
    "",
    "Audience:",
    "- A human returning days or months later who wants to understand what happened and why.",
    "- Future coding agents that need operational context, decisions, file paths, commands, failures, fixes, and next steps.",
    "",
    "Style:",
    "- Write as a concise engineering/research log, not a dry transcript or checklist.",
    "- Prefer short explanatory paragraphs plus targeted bullets where useful.",
    "- Preserve the reasoning behind decisions, not just the final actions.",
    "- Include exact file paths, command names, config keys, error messages, and successful verification steps when relevant.",
    "- If a problem was debugged, describe the symptom → cause → fix → verification chain.",
    "- Use Obsidian-friendly markdown. Add wikilinks only when they are clearly useful and inferable from the session; do not invent note names.",
    "",
    "Use this exact structure:",
    "",
    "#### Context",
    "A short narrative explaining the goal, project area, and why this session mattered.",
    "",
    "#### What Changed",
    "Describe the concrete changes made. Use bullets for files/configs/commands, but include enough explanation for future maintenance.",
    "",
    "#### Decisions & Rationale",
    "Capture important choices, tradeoffs, and why the chosen approach was used. If none, write \"None beyond implementation details.\"",
    "",
    "#### Debugging Notes / Gotchas",
    "Document errors encountered, root causes, fixes, and verification. If none, write \"None.\"",
    "",
    "#### Reusable Knowledge for Future Agents",
    "Explain what a future agent should remember: where things live, how to test them, assumptions, conventions, and safe next actions.",
    "",
    "#### Open Threads",
    "Anything unfinished, deferred, or worth checking next. If nothing, write \"None.\"",
    "",
    "Rules:",
    "- Do NOT include generic filler; every sentence should help future understanding or action.",
    "- Do NOT wrap the output in code fences or add any preamble.",
    "- Output ONLY the markdown sections above, nothing else.",
    "- If detail must be compressed, compress earlier facts deliberately; do not leave the final note incomplete.",
    "",
    `<${sourceKind}>`,
    sourceText,
    `</${sourceKind}>`,
  ].join("\n");
}

/** Build an intermediate chunk-summary prompt for hierarchical summarization. */
export function buildChunkSummaryPrompt(chunk: SummaryChunk, plan: SummaryPlan): string {
  return [
    `Summarize chunk ${chunk.index} of ${chunk.total} from a Pi coding-assistant session.`,
    "This is an intermediate summary that will be combined with other chunks; do not write the final daily-note structure yet.",
    "Preserve facts that future agents need: goals, constraints, decisions, file paths, commands, errors, fixes, verification, and open items.",
    "Do not drop information just because the chunk is long; compress densely and keep exact names/paths where relevant.",
    "Produce complete markdown bullets/paragraphs and never end mid-sentence.",
    `Detail level: ${plan.detailLevel}. Estimated chunk tokens: ${chunk.estimatedTokens}.`,
    "",
    "<chunk>",
    chunk.text,
    "</chunk>",
  ].join("\n");
}

/** Build a prompt that reduces many intermediate summaries into fewer summaries. */
export function buildReduceSummaryPrompt(chunk: SummaryChunk, plan: SummaryPlan, round: number): string {
  return [
    `Compress intermediate session summaries, reduction round ${round}, chunk ${chunk.index} of ${chunk.total}.`,
    "Keep all operationally important facts for the final daily note: goals, decisions, files, commands, errors, fixes, verification, and open items.",
    "Merge duplicates, preserve exact paths/names, and produce complete markdown that does not end mid-sentence.",
    `Detail level: ${plan.detailLevel}.`,
    "",
    "<intermediate-summaries>",
    chunk.text,
    "</intermediate-summaries>",
  ].join("\n");
}

/** Produce a tool-call summary that preserves full arguments for adaptive chunking. */
function summarizeToolCall(toolName: string, input: Record<string, any>): string {
  const headline = toolHeadline(toolName, input);
  return [
    headline,
    "",
    "Input:",
    "```json",
    stringifyForSummary(input),
    "```",
  ].join("\n");
}

/** Produce a tool-result summary that preserves full textual result content for adaptive chunking. */
function summarizeToolResult(
  toolName: string,
  input: Record<string, any>,
  content: unknown,
  isError: boolean
): string {
  return [
    `${toolHeadline(toolName, input)} — result${isError ? " (error)" : ""}`,
    "",
    "Input:",
    "```json",
    stringifyForSummary(input),
    "```",
    "",
    "Result content:",
    formatResultContent(content),
  ].join("\n");
}

function toolHeadline(toolName: string, input: Record<string, any>): string {
  switch (toolName) {
    case "read":
      return `Read \`${input.file_path || input.path || ""}\``;
    case "write":
      return `Wrote \`${input.file_path || input.path || ""}\``;
    case "edit":
      return `Edited \`${input.file_path || input.path || ""}\``;
    case "bash":
      return "Ran shell command";
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
      return `Called ${toolName}`;
  }
}

function stringifyForSummary(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch (e: any) {
    return `[unserializable value: ${e?.message || String(e)}]`;
  }
}

function formatResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyForSummary(content);

  const parts = content.map((block: any, i) => {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "image") {
      const size = typeof block.data === "string" ? block.data.length : 0;
      return `[image content ${i + 1}: ${block.mimeType || "unknown mime"}, ${size} base64 chars]`;
    }
    return stringifyForSummary(block);
  });
  return parts.join("\n\n");
}

function chooseOutputTokens(
  sourceTokens: number,
  detailLevel: DailySummaryDetailLevel,
  maxOutputTokens: number
): number {
  const settings = DETAIL_SETTINGS[detailLevel] ?? DETAIL_SETTINGS.normal;
  const desired = Math.ceil(sourceTokens * settings.ratio + settings.base);
  return clamp(desired, Math.min(settings.minOutput, maxOutputTokens), maxOutputTokens);
}

function computeInputBudget(contextWindow: number, outputTokens: number): number {
  // Do not force a floor that would exceed the context window. Callers can
  // reject plans below MIN_USABLE_INPUT_BUDGET_TOKENS with a clear error.
  return Math.max(1, contextWindow - outputTokens - PROMPT_OVERHEAD_TOKENS);
}

function splitOversizedUnit(unit: SummaryUnit, budgetTokens: number): SummaryUnit[] {
  if (estimateTokens(formatSummaryUnit(unit)) <= budgetTokens) return [unit];

  const emptyWrappedChars = formatSummaryUnit({ id: `${unit.id}-part-1`, text: "" }).length;
  const maxChars = Math.max(
    100,
    Math.floor(budgetTokens * CHARS_PER_TOKEN_ESTIMATE * 0.8) - emptyWrappedChars
  );
  const parts = splitTextLosslessly(unit.text, maxChars);
  return parts.map((part, i) => ({
    id: `${unit.id}-part-${i + 1}-of-${parts.length}`,
    text: [
      `# ${unit.id} (part ${i + 1} of ${parts.length})`,
      "This unit was split because it exceeded the model input budget. No content was intentionally omitted.",
      "",
      part,
    ].join("\n"),
  }));
}

function splitTextLosslessly(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const splitAt = findSafeSplitIndex(remaining, maxChars);
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function findSafeSplitIndex(text: string, maxChars: number): number {
  const hardLimit = Math.min(maxChars, text.length);
  const minUseful = Math.floor(hardLimit * 0.5);
  const separators = ["\n\n", "\n", ". ", "; ", ", ", " "];

  for (const separator of separators) {
    const idx = text.lastIndexOf(separator, hardLimit);
    if (idx >= minUseful) return idx + separator.length;
  }

  return hardLimit;
}

function densityHint(sourceTokens: number, detailLevel: DailySummaryDetailLevel): string {
  if (sourceTokens < 500) {
    return "This was a very short session. Keep the note brief but still capture any reusable context.";
  }
  if (sourceTokens < 2500) {
    return "This was a short session. Capture the goal, concrete actions, and any decisions without over-expanding.";
  }
  if (sourceTokens < 10_000) {
    return "This was a moderate session. Write a useful knowledge-base entry with narrative context, concrete changes, and reusable lessons.";
  }
  if (detailLevel === "concise") {
    return "This was a long session. Be concise, but preserve the decisions, important paths, commands, failures, fixes, and next steps.";
  }
  return "This was a long session. Write a dense but readable knowledge-base entry. Prioritize context, decisions, implementation details, gotchas, and future-agent guidance.";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Get today's daily file path. */
export function getDailyFilePath(config: VaultConfig): string {
  const now = new Date();
  const filename = formatDateForFilename(now, config.dailySummary.filenameFormat);
  return `${config.dailySummary.folder}/${filename}.md`;
}

/** Append a pre-generated summary entry to the daily file. */
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

  const entry = `### ${heading}\n\n${summaryBody.trimEnd()}`;

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
