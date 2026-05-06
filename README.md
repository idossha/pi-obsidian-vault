# pi-obsidian-vault

A [Pi](https://github.com/badlogic/pi-mono) extension for filesystem-native Obsidian vault integration. Read, write, search, and navigate your vault directly from Pi — no Obsidian app required.

## Features

- **Agent-only vault tools** — Pi agents can read, write, search, list, inspect tags/backlinks, and edit metadata under the hood
- **Wikilink resolution** — resolve `[[note names]]` to file paths like Obsidian does
- **Both metadata styles** — supports YAML frontmatter and plaintext metadata headers
- **Auto-detection** — reads `.obsidian/` settings to detect your vault's conventions (folders, metadata style, date formats, templates, footer)
- **Template support** — create notes from your existing Obsidian templates with variable expansion
- **LLM-powered daily session log** — automatically summarizes your Pi sessions via the LLM and appends structured entries to a daily note
- **Configurable** — works out of the box with auto-detection, or fine-tune via `vault.config.json`

## Install

```bash
# From git
pi install git:github.com/idossha/pi-obsidian-vault

# From a local clone
pi install /path/to/pi-obsidian-vault

# One-off test run
pi -e /path/to/pi-obsidian-vault/extensions/index.ts
```

## Setup

Set your vault path via environment variable:

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
```

Or add it to your Pi settings (`~/.pi/agent/settings.json` or `.pi/settings.json`):

```json
{
  "obsidianVault": "/path/to/your/vault"
}
```

That's it. The extension auto-detects your vault's folder structure, metadata style, templates, and conventions from `.obsidian/` settings.

## Agent Integration

The extension registers Obsidian vault tools for the Pi harness and agent to use internally. These are not exposed as human-facing slash commands; use natural language to ask Pi to read, write, search, or organize vault notes.

## Commands

| Command | Description |
|---------|-------------|
| `/vault` | Show actionable vault status, conventions, daily-summary state, and next commands |
| `/vault:help` | Show focused vault command help |
| `/vault:flush` | Summarize current session via LLM and write to today's daily note now |
| `/vault:init` | Auto-detect vault conventions and generate `vault.config.json` |

## Skill

The extension includes an `obsidian-vault` skill that teaches Pi about Obsidian markdown conventions (wikilinks, embeds, callouts, metadata styles) and how to use the under-the-hood vault tools effectively.

## Daily Session Log

Every time you end a Pi session, the extension summarizes tracked session context and appends the result to `Daily/YYYY-MM-DD.md` (or the detected/configured daily folder) in your vault.

Summarization is adaptive rather than capped by a fixed line or character limit:

- The extension estimates the amount of conversation/tool context and the selected summary model's context window.
- If the session fits, it summarizes in one pass.
- If the session is larger than the model window, it splits the context into processed chunks and combines them hierarchically.
- It does not raw-slice the final note. If the LLM stops because of output length, the extension retries with a larger output budget and refuses to append incomplete output if the model still cannot finish.

The LLM produces a structured summary with these sections:

- **Context** — goal, project area, and why the session mattered
- **What Changed** — files/configs/commands and concrete changes
- **Decisions & Rationale** — important choices and tradeoffs
- **Debugging Notes / Gotchas** — symptoms, causes, fixes, and verification
- **Reusable Knowledge for Future Agents** — conventions, assumptions, and safe next actions
- **Open Threads** — unfinished or deferred items

The raw conversation (user prompts, assistant responses, tool calls, files touched, shell commands) is collected throughout the session and planned against the summary model context at shutdown or `/vault:flush` time.

Example daily file:

```markdown
Created: 20260405 1430
Tags: #daily
Links:

---

### 14:30 → 15:12 — Session Log

> **Model:** anthropic/claude-sonnet-4-20250514
> **Project:** `/Users/ido/projects/pi-obsidian-vault`
> **Summary:** adaptive/normal, single-pass, 1 chunk, ~1800 source tokens

#### Context
Refactored the search module in `lib/search.ts` so vault search could support regex queries while preserving the existing plain-text search workflow.

#### What Changed
- Edited `lib/search.ts` to add a `regex` option to `searchVault()` and refactor match handling.
- Ran `npx tsc --noEmit` to verify compilation.
- Updated `README.md` with the new search parameter.

#### Decisions & Rationale
Regex support is opt-in (`regex: true`) so existing case-insensitive substring searches keep their previous behavior.

#### Debugging Notes / Gotchas
None.

#### Reusable Knowledge for Future Agents
Use the agent's vault search capability in regex mode only when the query is intended as a regular expression; otherwise prefer safer literal matching.

#### Open Threads
None.

### 16:45 → 17:03 — Session Log

> **Model:** openai/gpt-4o
> **Project:** `/Users/ido/research/neuro-analysis`
> **Summary:** adaptive/normal, single-pass, 1 chunk, ~950 source tokens

#### Context
Explored existing neuroimaging notes to create a connected note on fMRI preprocessing.

#### What Changed
- Searched the vault for "neuroimaging".
- Read `Zettelkasten/Brain Atlases.md` for context.
- Created `Zettelkasten/fMRI Preprocessing.md` with a pipeline overview.

#### Decisions & Rationale
The new note links to existing atlas context so future work can connect preprocessing decisions to anatomical reference material.

#### Debugging Notes / Gotchas
None.

#### Reusable Knowledge for Future Agents
Before adding neuroimaging notes, search for existing atlas/preprocessing material and prefer wikilinks to established notes over duplicate standalone summaries.

#### Open Threads
Add a section on motion-correction parameters.

---
# References
```

By default the extension uses the current session model for summarization. You can configure a dedicated (cheaper/faster) model via `dailySummary.summaryModel`, and a preferred density via `dailySummary.detailLevel` (`concise`, `normal`, or `detailed`).

Disable daily logging by setting `dailySummary.enabled` to `false` in `vault.config.json`.

## Configuration

Run `/vault:init` to generate a `vault.config.json` in your vault root. The extension auto-detects all values, but you can customize:

```json
{
  "folders": {
    "notes": "Zettelkasten",
    "hubs": "Hubs",
    "templates": "Templates",
    "attachments": "Assets",
    "daily": null,
    "inbox": null,
    "archive": null,
    "projects": "projects"
  },
  "metadata": {
    "style": "plaintext",
    "fields": {
      "created": "Created",
      "status": "Status",
      "tags": "Tags",
      "links": "Links"
    },
    "dateFormat": "YYYYMMDD HHmm"
  },
  "templates": {
    "engine": "core",
    "dateFormat": "YYYYMMDD",
    "timeFormat": "HHmm",
    "noteTemplates": {
      "concept": "LLM_Instructions.md",
      "project": "Project Template.md"
    }
  },
  "conventions": {
    "naming": "title-case",
    "tagStyle": "flat",
    "footer": "# References"
  },
  "dailySummary": {
    "enabled": true,
    "folder": "Daily",
    "filenameFormat": "YYYY-MM-DD",
    "detailLevel": "normal",
    "summaryModel": ""
  }
}
```

### Metadata Styles

**YAML frontmatter** (default for most vaults):

```yaml
---
tags:
  - topic
created: 2024-01-15
---
```

**Plaintext headers** (auto-detected if your notes use this pattern):

```
Created: 20240115 1030
Status: #in_progress
Tags: #topic
Links: [[Related Note]]

---
```

The extension handles both transparently.

### Daily Summary Options

| Key | Default | Description |
|-----|---------|-------------|
| `dailySummary.enabled` | `true` | Enable/disable session logging |
| `dailySummary.folder` | `"Daily"` | Vault subfolder for daily files |
| `dailySummary.filenameFormat` | `"YYYY-MM-DD"` | Date format for the daily filename |
| `dailySummary.detailLevel` | `"normal"` | Preferred summary density: `"concise"`, `"normal"`, or `"detailed"`. Actual processing is still based on source context size and model window. |
| `dailySummary.summaryModel` | `""` | Model for summarization in `"provider/model-id"` format (e.g. `"anthropic/claude-sonnet-4-20250514"`, `"openai/gpt-4o"`). Empty string uses the current session model. |

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) v0.50.0 or later
- An Obsidian vault (any folder of markdown files)
- Obsidian does **not** need to be running

## License

MIT
