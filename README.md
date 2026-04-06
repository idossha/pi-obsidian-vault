# pi-obsidian-vault

A [Pi](https://github.com/badlogic/pi-mono) extension for filesystem-native Obsidian vault integration. Read, write, search, and navigate your vault directly from Pi — no Obsidian app required.

## Features

- **7 vault tools** — read, write, search, list, tags, backlinks, metadata
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

## Tools

| Tool | Description |
|------|-------------|
| `vault_read` | Read a note by path or wikilink name |
| `vault_write` | Create, overwrite, or append to a note (with template support) |
| `vault_search` | Full-text search with optional regex and subfolder filtering |
| `vault_list` | List files and directories in the vault |
| `vault_tags` | List all tags or find notes by a specific tag |
| `vault_backlinks` | Find all notes that link to a given note |
| `vault_metadata` | Read, set, or delete metadata fields (YAML or plaintext) |

## Commands

| Command | Description |
|---------|-------------|
| `/vault` | Show vault info (path, note count, detected config) |
| `/vault:help` | Show all vault commands and tools with descriptions |
| `/vault:daily` | View today's daily session log |
| `/vault:daily flush` | Summarize current session via LLM and write to daily file now |
| `/vault:init` | Auto-detect vault conventions and generate `vault.config.json` |

## Skill

The extension includes an `obsidian-vault` skill that teaches Pi about Obsidian markdown conventions (wikilinks, embeds, callouts, metadata styles) and how to use the vault tools effectively.

## Daily Session Log

Every time you end a Pi session, the extension sends the full conversation to the LLM for summarization, then appends the result to `Daily/YYYY-MM-DD.md` in your vault. The LLM produces a structured summary with these sections:

- **Overview** — one or two sentence high-level description
- **Topics Discussed** — what the user asked about
- **Actions Taken** — files created/edited, commands run, configurations changed
- **Key Outcomes** — important results, decisions, or conclusions
- **Open Items** — anything left unfinished or explicitly deferred

The raw conversation (user prompts, assistant responses, tool calls, files touched, shell commands) is collected throughout the session and passed to the LLM at shutdown for summarization.

Example daily file:

```markdown
Created: 20260405 1430
Tags: #daily
Links:

---

### 14:30 → 15:12 — Session Log

> **Model:** anthropic/claude-sonnet-4-20250514
> **Project:** `/Users/ido/projects/pi-obsidian-vault`

#### Overview
Refactored the search module in `lib/search.ts` to support regex queries and added test coverage.

#### Topics Discussed
- Refactoring the search module for regex support
- Testing the refactored search against the vault
- Updating documentation to reflect changes

#### Actions Taken
- Edited `lib/search.ts` — added `regex` option to `searchVault()` and refactored match logic
- Ran `npx tsc --noEmit` to verify compilation
- Updated `README.md` with new search parameters

#### Key Outcomes
- Search now supports optional regex mode via `regex: true` parameter
- All existing tests pass, no regressions

#### Open Items
- None.

### 16:45 → 17:03 — Session Log

> **Model:** openai/gpt-4o
> **Project:** `/Users/ido/research/neuro-analysis`

#### Overview
Explored neuroimaging notes and created a new note on fMRI preprocessing.

#### Topics Discussed
- Finding notes related to neuroimaging
- Creating a structured note on fMRI preprocessing pipelines

#### Actions Taken
- Searched vault for "neuroimaging"
- Read `Zettelkasten/Brain Atlases.md` for context
- Created `Zettelkasten/fMRI Preprocessing.md` with pipeline overview

#### Key Outcomes
- New fMRI preprocessing note created with links to existing atlas notes

#### Open Items
- Add section on motion correction parameters

---
# References
```

By default the extension uses the current session model for summarization. You can configure a dedicated (cheaper/faster) model via `dailySummary.summaryModel`.

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
    "maxLength": 3000,
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
| `dailySummary.maxLength` | `3000` | Maximum character length for the summary body |
| `dailySummary.summaryModel` | `""` | Model for summarization in `"provider/model-id"` format (e.g. `"anthropic/claude-sonnet-4-20250514"`, `"openai/gpt-4o"`). Empty string uses the current session model. |

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) v0.50.0 or later
- An Obsidian vault (any folder of markdown files)
- Obsidian does **not** need to be running

## License

MIT
