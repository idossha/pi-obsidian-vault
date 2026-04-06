import { Type, StringEnum, complete, getModel } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Vault } from "../lib/vault.js";
import { loadConfig, generateConfigFile, type VaultConfig } from "../lib/config.js";
import {
  parseMetadata,
  updateMetadataField,
  deleteMetadataField,
  getSemanticFields,
} from "../lib/metadata.js";
import { extractWikilinks, extractInlineTags } from "../lib/wikilinks.js";
import { searchVault } from "../lib/search.js";
import { SessionTracker, appendSessionSummary, getDailyFilePath, buildSummaryPrompt } from "../lib/daily.js";

export default function (pi: ExtensionAPI) {
  let vault: Vault;
  try {
    vault = Vault.discover();
  } catch (e: any) {
    console.error(`[obsidian-vault] ${e.message}`);
    return;
  }

  const config = loadConfig(vault.root);

  // ── Startup notification ─────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" && ctx.hasUI) {
      const noteCount = vault.getAllMarkdownFiles().length;
      ctx.ui.notify(
        `📓 Obsidian vault loaded: ${noteCount} notes\n` +
        `   /vault  /vault:help  /vault:daily  /vault:init`,
        "info"
      );
    }
  });

  // ── Session tracking for daily summaries ────────────────────────────
  let tracker = new SessionTracker();

  if (config.dailySummary.enabled) {
    // Track every user prompt
    pi.on("input", async (event) => {
      if (event.text) {
        tracker.trackPrompt(event.text);
      }
    });

    // Track assistant responses
    pi.on("message_end", async (event) => {
      try {
        const msg = event.message;
        if (msg.role === "assistant" && msg.content) {
          const text = extractMessageText(msg.content);
          if (text.trim()) {
            tracker.trackAssistantResponse(text);
          }
        }
      } catch {
        // Don't let tracking errors break message flow
      }
    });

    // Track every tool call (all tools, not just vault_*)
    pi.on("tool_call", async (event) => {
      try {
        tracker.trackToolCall(event.toolName, event.input as Record<string, any>);
      } catch {
        // Don't let tracking errors break tool execution
      }
    });

    // Flush summary to daily file on session end
    pi.on("session_shutdown", async (_event, ctx) => {
      try {
        if (!tracker.hasActivity()) return;
        await summarizeAndAppend(vault, config, tracker, ctx);
      } catch (e: any) {
        console.error(`[obsidian-vault] Failed to write daily summary: ${e.message}`);
      }
    });

    // Reset or restore tracker on session lifecycle events
    pi.on("session_start", async (event, ctx) => {
      if (event.reason === "new" || event.reason === "fork") {
        tracker = new SessionTracker();
      } else if (event.reason === "startup" || event.reason === "reload") {
        // Reconstruct tracker from session history so /reload doesn't lose data
        tracker = new SessionTracker();
        try {
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "message" || !entry.message) continue;
            const msg = entry.message as any;
            if (msg.role === "user") {
              const text = extractMessageText(msg.content);
              if (text) tracker.trackPrompt(text);
            } else if (msg.role === "assistant") {
              const text = extractMessageText(msg.content);
              if (text) tracker.trackAssistantResponse(text);
            } else if (msg.role === "toolResult" || msg.role === "tool") {
              // Reconstruct tool call tracking from result entries
              if (msg.toolName) {
                tracker.trackToolCall(msg.toolName, msg.details ?? {});
              }
            }
          }
        } catch {
          // If reconstruction fails, start fresh — better than crashing
        }
      }
    });
  }

  // ── vault_read ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "vault_read",
    label: "Read Note",
    description:
      "Read an Obsidian note by path or wikilink name. Returns the full content including metadata.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Vault-relative path (e.g., 'Zettelkasten/my-note.md')" })
      ),
      name: Type.Optional(
        Type.String({ description: "Note name for wikilink-style resolution (e.g., 'my-note')" })
      ),
    }),
    async execute(_toolCallId, params) {
      const resolved = resolveNoteParam(vault, params);
      const content = vault.read(resolved);
      const parsed = parseMetadata(content, config.metadata);
      const semantic = parsed.hasMetadata
        ? getSemanticFields(parsed.metadata, config.metadata)
        : null;
      return {
        content: [{ type: "text" as const, text: content }],
        details: {
          path: resolved,
          lines: content.split("\n").length,
          hasMetadata: parsed.hasMetadata,
          metadataStyle: parsed.style,
          semantic,
        },
      };
    },
  });

  // ── vault_write ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "vault_write",
    label: "Write Note",
    description:
      "Create a new note, overwrite an existing one, or append content. " +
      `Default notes folder: "${config.folders.notes || "(vault root)"}". ` +
      `Metadata style: ${config.metadata.style}.` +
      (config.conventions.footer ? ` Notes end with "${config.conventions.footer}".` : ""),
    parameters: Type.Object({
      path: Type.String({
        description: "Vault-relative path for the note (e.g., 'Zettelkasten/new-note.md')",
      }),
      content: Type.String({ description: "Content to write" }),
      mode: StringEnum(["create", "overwrite", "append"] as const, {
        description: "create: fail if exists. overwrite: create or replace. append: add to end.",
      }),
      template: Type.Optional(
        Type.String({
          description: `Template name to apply. Available: ${Object.keys(config.templates.noteTemplates).join(", ") || "(none configured)"}`,
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const fullPath = vault.resolve(params.path);
      return await withFileMutationQueue(fullPath, async () => {
        if (params.mode === "create" && vault.exists(params.path)) {
          throw new Error(`Note already exists: ${params.path}. Use 'overwrite' mode to replace.`);
        }

        let content = params.content;

        // Apply template if specified
        if (params.template && params.mode !== "append") {
          content = applyTemplate(vault, config, params.template, params.path, content);
        }

        if (params.mode === "append") {
          vault.append(params.path, content);
        } else {
          vault.write(params.path, content);
        }

        const verb = params.mode === "create" ? "Created" : params.mode === "append" ? "Appended to" : "Wrote";
        return {
          content: [{ type: "text" as const, text: `${verb} ${params.path}` }],
          details: { path: params.path, mode: params.mode },
        };
      });
    },
  });

  // ── vault_search ────────────────────────────────────────────────────
  pi.registerTool({
    name: "vault_search",
    label: "Search Vault",
    description:
      "Full-text search across all markdown files in the Obsidian vault. Returns matching lines with context.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (case-insensitive, or regex if regex=true)" }),
      path_filter: Type.Optional(
        Type.String({ description: "Restrict search to this subfolder (e.g., 'Zettelkasten')" })
      ),
      limit: Type.Optional(Type.Number({ description: "Max files to return (default: 20)" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat query as regex (default: false)" })),
    }),
    async execute(_toolCallId, params) {
      const results = searchVault(vault, params.query, {
        pathFilter: params.path_filter,
        limit: params.limit,
        regex: params.regex,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
          details: { count: 0, totalMatches: 0 },
        };
      }

      const lines: string[] = [];
      for (const result of results) {
        lines.push(`## ${result.path} (${result.matches.length} matches)`);
        for (const m of result.matches.slice(0, 5)) {
          lines.push(`  L${m.line}: ${m.text.trim()}`);
        }
        if (result.matches.length > 5) {
          lines.push(`  ... and ${result.matches.length - 5} more matches`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          count: results.length,
          totalMatches: results.reduce((s, r) => s + r.matches.length, 0),
        },
      };
    },
  });

  // ── vault_list ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "vault_list",
    label: "List Vault",
    description: "List files and directories in the Obsidian vault.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Subfolder path (default: vault root)" })),
      recursive: Type.Optional(Type.Boolean({ description: "List recursively (default: false)" })),
    }),
    async execute(_toolCallId, params) {
      const entries = vault.listDir(params.path, params.recursive);
      const lines = entries.map(
        (e) => `${e.type === "directory" ? "📁" : "📄"} ${e.name}`
      );
      return {
        content: [
          { type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "(empty directory)" },
        ],
        details: {
          path: params.path || "/",
          files: entries.filter((e) => e.type === "file").length,
          directories: entries.filter((e) => e.type === "directory").length,
        },
      };
    },
  });

  // ── vault_tags ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "vault_tags",
    label: "Vault Tags",
    description:
      "List all tags in the vault, or find all notes with a specific tag. " +
      "Checks both metadata tags and inline #tags.",
    parameters: Type.Object({
      tag: Type.Optional(
        Type.String({ description: "Find notes with this tag (without #). Omit to list all." })
      ),
    }),
    async execute(_toolCallId, params) {
      const files = vault.getAllMarkdownFiles();
      const tagMap = new Map<string, string[]>();

      for (const file of files) {
        let content: string;
        try {
          content = vault.read(file);
        } catch {
          continue;
        }

        const allTags = new Set<string>();

        // Tags from metadata
        const parsed = parseMetadata(content, config.metadata);
        if (parsed.hasMetadata) {
          const semantic = getSemanticFields(parsed.metadata, config.metadata);
          for (const t of semantic.tags) allTags.add(t);
          // Also check status field for tags (common in plaintext vaults)
          if (config.metadata.style === "plaintext" && semantic.status) {
            const statusTags = semantic.status.match(/#([a-zA-Z][a-zA-Z0-9_/\-]*)/g);
            if (statusTags) {
              for (const t of statusTags) allTags.add(t.replace(/^#/, ""));
            }
          }
        }

        // Inline tags
        for (const t of extractInlineTags(content)) {
          allTags.add(t);
        }

        for (const t of allTags) {
          const normalized = t.replace(/^#/, "");
          if (!tagMap.has(normalized)) tagMap.set(normalized, []);
          tagMap.get(normalized)!.push(file);
        }
      }

      if (params.tag) {
        const normalized = params.tag.replace(/^#/, "");
        const notes = tagMap.get(normalized) || [];
        const text =
          notes.length > 0
            ? `Notes with tag #${normalized}:\n${notes.map((n) => `  - ${n}`).join("\n")}`
            : `No notes found with tag #${normalized}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { tag: normalized, count: notes.length, totalTags: tagMap.size },
        };
      }

      const sorted = [...tagMap.entries()].sort((a, b) => b[1].length - a[1].length);
      const lines = sorted.map(([tag, notes]) => `#${tag} (${notes.length})`);
      return {
        content: [
          { type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "No tags found." },
        ],
        details: { tag: "", count: 0, totalTags: sorted.length },
      };
    },
  });

  // ── vault_backlinks ─────────────────────────────────────────────────
  pi.registerTool({
    name: "vault_backlinks",
    label: "Backlinks",
    description:
      "Find all notes that contain a [[wikilink]] to the given note. " +
      "Also checks the metadata Links field for plaintext-style vaults.",
    parameters: Type.Object({
      name: Type.String({ description: "Note name to find backlinks for (e.g., 'my-note')" }),
    }),
    async execute(_toolCallId, params) {
      const target = params.name.replace(/\.md$/, "").toLowerCase();
      const files = vault.getAllMarkdownFiles();
      const backlinks: Array<{ file: string; links: string[] }> = [];

      for (const file of files) {
        let content: string;
        try {
          content = vault.read(file);
        } catch {
          continue;
        }

        // Check inline wikilinks
        const wikilinks = extractWikilinks(content);
        const matching = wikilinks.filter((wl) => {
          const linkTarget = wl.target.replace(/\.md$/, "").toLowerCase();
          return (
            linkTarget === target ||
            linkTarget.split("/").pop() === target ||
            target.split("/").pop() === linkTarget
          );
        });

        if (matching.length > 0) {
          backlinks.push({ file, links: matching.map((wl) => wl.raw) });
        }
      }

      if (backlinks.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No backlinks found for "${params.name}".` }],
          details: { count: 0 },
        };
      }

      const lines = backlinks.map(
        (bl) => `${bl.file}\n${bl.links.map((l) => `  ${l}`).join("\n")}`
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Backlinks to "${params.name}" (${backlinks.length} notes):\n\n${lines.join("\n\n")}`,
          },
        ],
        details: { count: backlinks.length },
      };
    },
  });

  // ── vault_metadata ──────────────────────────────────────────────────
  pi.registerTool({
    name: "vault_metadata",
    label: "Metadata",
    description:
      `Read, set, or delete metadata fields on a note. ` +
      `This vault uses ${config.metadata.style} metadata style. ` +
      (config.metadata.style === "plaintext"
        ? `Fields: ${Object.entries(config.metadata.fields).map(([k, v]) => `${k}=${v}`).join(", ")}.`
        : "Fields are YAML frontmatter."),
    parameters: Type.Object({
      path: Type.String({ description: "Vault-relative path to the note" }),
      action: StringEnum(["read", "set", "delete"] as const, {
        description: "read: return metadata. set: update a field. delete: remove a field.",
      }),
      key: Type.Optional(Type.String({ description: "Metadata key (required for set/delete)" })),
      value: Type.Optional(
        Type.String({ description: "Value to set (required for set). JSON for complex values." })
      ),
    }),
    async execute(_toolCallId, params) {
      const content = vault.read(params.path);
      const parsed = parseMetadata(content, config.metadata);

      if (params.action === "read") {
        const entries = Object.entries(parsed.metadata);
        const text =
          entries.length > 0
            ? entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
            : "No metadata found.";

        const semantic = parsed.hasMetadata
          ? getSemanticFields(parsed.metadata, config.metadata)
          : null;

        return {
          content: [{ type: "text" as const, text }],
          details: {
            path: params.path,
            action: "read" as const,
            key: "",
            metadata: parsed.metadata as any,
            semantic: semantic as any,
          },
        };
      }

      if (!params.key) {
        throw new Error(`"key" is required for ${params.action} action`);
      }

      const fullPath = vault.resolve(params.path);
      return await withFileMutationQueue(fullPath, async () => {
        const current = vault.read(params.path);
        let updated: string;

        if (params.action === "set") {
          if (params.value === undefined) {
            throw new Error('"value" is required for set action');
          }
          let parsedValue: unknown;
          if (config.metadata.style === "yaml") {
            try {
              parsedValue = JSON.parse(params.value);
            } catch {
              parsedValue = params.value;
            }
          } else {
            // Plaintext: keep as string
            parsedValue = params.value;
          }
          updated = updateMetadataField(current, params.key!, parsedValue, config.metadata);
        } else {
          updated = deleteMetadataField(current, params.key!, config.metadata);
        }

        vault.write(params.path, updated);
        return {
          content: [
            {
              type: "text" as const,
              text: `${params.action === "set" ? "Set" : "Deleted"} "${params.key}" on ${params.path}`,
            },
          ],
          details: {
            path: params.path,
            action: params.action as string,
            key: params.key!,
            metadata: null as any,
            semantic: null,
          },
        };
      });
    },
  });

  // ── /vault:help command ─────────────────────────────────────────────
  pi.registerCommand("vault:help", {
    description: "Show all vault commands and usage",
    async handler(_args, ctx) {
      const help = [
        "📓 Obsidian Vault Commands",
        "",
        "/vault          — Show vault info (path, note count, metadata style, templates)",
        "/vault:help     — Show this help message",
        "/vault:daily    — View today's daily session log",
        "/vault:daily flush — Summarize current session and write to daily file now",
        "/vault:init     — Auto-detect vault conventions and generate vault.config.json",
        "",
        "Tools available to the LLM:",
        "  vault_read      — Read a note by path or [[wikilink]]",
        "  vault_write     — Create, overwrite, or append to a note",
        "  vault_search    — Full-text search (supports regex)",
        "  vault_list      — List files and directories",
        "  vault_tags      — List all tags or find notes by tag",
        "  vault_backlinks — Find notes linking to a given note",
        "  vault_metadata  — Read, set, or delete note metadata",
      ].join("\n");

      if (ctx.hasUI) {
        ctx.ui.notify(help, "info");
      }
    },
  });

  // ── /vault command ──────────────────────────────────────────────────
  pi.registerCommand("vault", {
    description: "Show vault info (path, notes, config) — try /vault:help for all commands",
    async handler(_args, ctx) {
      const files = vault.getAllMarkdownFiles();
      const entries = vault.listDir();
      const dirs = entries.filter((e) => e.type === "directory");

      const info = [
        `Vault: ${vault.root}`,
        `Notes: ${files.length}`,
        `Top-level folders: ${dirs.map((d) => d.name).join(", ")}`,
        `Metadata style: ${config.metadata.style}`,
        `Notes folder: ${config.folders.notes || "(root)"}`,
        `Templates: ${Object.keys(config.templates.noteTemplates).join(", ") || "(none)"}`,
        `Footer: ${config.conventions.footer || "(none)"}`,
      ].join("\n");

      if (ctx.hasUI) {
        ctx.ui.notify(info, "info");
      }
    },
  });

  // ── /vault:daily command ────────────────────────────────────────────
  pi.registerCommand("vault:daily", {
    description: "View today's daily log, or '/vault:daily flush' to write current session now",
    async handler(args, ctx) {
      const dailyPath = getDailyFilePath(config);

      if (args?.trim() === "flush") {
        // Write current session summary immediately
        if (!tracker.hasActivity()) {
          if (ctx.hasUI) ctx.ui.notify("No vault activity in this session yet.", "info");
          return;
        }
        try {
          if (ctx.hasUI) ctx.ui.notify("Generating LLM summary...", "info");
          await summarizeAndAppend(vault, config, tracker, ctx);
          tracker = new SessionTracker();
          if (ctx.hasUI) ctx.ui.notify(`Session summary appended to ${dailyPath}`, "info");
        } catch (e: any) {
          if (ctx.hasUI) ctx.ui.notify(`Error: ${e.message}`, "error");
        }
        return;
      }

      // Show today's daily file
      if (vault.exists(dailyPath)) {
        const content = vault.read(dailyPath);
        if (ctx.hasUI) {
          ctx.ui.notify(`${dailyPath}:\n\n${content.slice(0, 1000)}`, "info");
        }
      } else {
        if (ctx.hasUI) {
          ctx.ui.notify(`No daily file yet for today (${dailyPath}). Vault activity will be logged on session end.`, "info");
        }
      }
    },
  });

  // ── /vault:init command ─────────────────────────────────────────────
  pi.registerCommand("vault:init", {
    description: "Auto-detect vault conventions and generate vault.config.json",
    async handler(_args, ctx) {
      const configPath = `${vault.root}/vault.config.json`;
      const configContent = generateConfigFile(vault.root);

      if (ctx.hasUI) {
        const exists = vault.exists("vault.config.json");
        if (exists) {
          const overwrite = await ctx.ui.confirm(
            "vault.config.json already exists. Overwrite?",
            "This will replace the current config with auto-detected settings."
          );
          if (!overwrite) return;
        }
      }

      const fs = await import("node:fs");
      fs.writeFileSync(configPath, configContent, "utf-8");

      if (ctx.hasUI) {
        ctx.ui.notify(`Generated vault.config.json at ${configPath}`, "info");
      }
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveNoteParam(
  vault: Vault,
  params: { path?: string; name?: string }
): string {
  if (params.path) return params.path;
  if (params.name) {
    const resolved = vault.resolveWikilink(params.name);
    if (!resolved) throw new Error(`Could not resolve note: "${params.name}"`);
    return resolved;
  }
  throw new Error('Either "path" or "name" must be provided');
}

function applyTemplate(
  vault: Vault,
  config: VaultConfig,
  templateName: string,
  notePath: string,
  userContent: string
): string {
  const templateFile = config.templates.noteTemplates[templateName];
  if (!templateFile) {
    const available = Object.keys(config.templates.noteTemplates).join(", ");
    throw new Error(`Unknown template "${templateName}". Available: ${available}`);
  }

  const templatePath = `${config.folders.templates}/${templateFile}`;
  let template: string;
  try {
    template = vault.read(templatePath);
  } catch {
    throw new Error(`Template file not found: ${templatePath}`);
  }

  const now = new Date();
  const title = notePath
    .replace(/\.md$/, "")
    .split("/")
    .pop() || "";

  // Replace core Obsidian template variables
  template = template
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{date\}\}/g, formatDate(now, config.templates.dateFormat))
    .replace(/\{\{time\}\}/g, formatDate(now, config.templates.timeFormat))
    .replace(/\{\{date:([^}]+)\}\}/g, (_, fmt) => formatDate(now, fmt))
    .replace(/\{\{time:([^}]+)\}\}/g, (_, fmt) => formatDate(now, fmt));

  // If user provided content, append it to the template
  if (userContent.trim()) {
    template = template + "\n" + userContent;
  }

  return template;
}

function formatDate(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  return format
    .replace(/YYYY/g, year)
    .replace(/YY/g, year.slice(2))
    .replace(/MM/g, month)
    .replace(/DD/g, day)
    .replace(/HH/g, hours)
    .replace(/mm/g, minutes)
    .replace(/ss/g, seconds);
}

/** Extract text from a message content field (string, array of blocks, etc.) */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

/**
 * Call the LLM to summarize the session, then append to the daily file.
 */
async function summarizeAndAppend(
  vault: Vault,
  config: VaultConfig,
  tracker: SessionTracker,
  ctx: ExtensionContext
): Promise<void> {
  const conversationText = tracker.toConversationText();
  const prompt = buildSummaryPrompt(conversationText, config.dailySummary.maxLength);

  // Resolve model: use configured summaryModel, or fall back to current session model
  let model = ctx.model;
  if (config.dailySummary.summaryModel) {
    const [provider, id] = config.dailySummary.summaryModel.split("/", 2);
    if (provider && id) {
      const found = getModel(provider, id);
      if (found) model = found;
    }
  }

  if (!model) {
    throw new Error("No model available for summarization");
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(`No API key for ${model.provider}/${model.id}`);
  }

  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
    }
  );

  const summary = response.content
    .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

  if (!summary.trim()) {
    throw new Error("LLM returned empty summary");
  }

  // Build heading and metadata block
  const startTime = tracker.getStartTime();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const timeRange = `${pad2(startTime.getHours())}:${pad2(startTime.getMinutes())} → ${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}`;
  const heading = `${timeRange} — Session Log`;

  const modelLabel = `${model.provider}/${model.id}`;
  const metaLines = [
    `> **Model:** ${modelLabel}`,
    `> **Project:** \`${ctx.cwd}\``,
  ];
  const fullSummary = metaLines.join("\n") + "\n\n" + summary;

  appendSessionSummary(vault, config, heading, fullSummary);
}
