# pi-obsidian-vault

A [Pi](https://github.com/badlogic/pi-mono) extension for filesystem-native Obsidian vault integration. Read, write, search, and navigate your vault directly from Pi — no Obsidian app required.

## Features

- **7 vault tools** — read, write, search, list, tags, backlinks, metadata
- **Wikilink resolution** — resolve `[[note names]]` to file paths like Obsidian does
- **Both metadata styles** — supports YAML frontmatter and plaintext metadata headers
- **Auto-detection** — reads `.obsidian/` settings to detect your vault's conventions (folders, metadata style, date formats, templates, footer)
- **Template support** — create notes from your existing Obsidian templates with variable expansion
- **Daily session log** — automatically appends a structured summary of your Pi sessions to a daily note
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
| `/vault:init` | Generate `vault.config.json` from auto-detected settings |
| `/vault:daily` | View today's daily session log |
| `/vault:daily flush` | Write current session's log to the daily file immediately |

## Skill

The extension includes an `obsidian-vault` skill that teaches Pi about Obsidian markdown conventions (wikilinks, embeds, callouts, metadata styles) and how to use the vault tools effectively.

## Daily Session Log

Every time you end a Pi session, the extension appends a structured summary to `Daily/YYYY-MM-DD.md` in your vault. It captures:

- Every prompt you sent (with topic extraction)
- Files read, written, and edited (all Pi tools, not just vault tools)
- Bash commands executed
- Vault operations (search queries, tag scans, backlink checks)
- Conversation topics discussed

Example daily file:

```markdown
Created: 20260405 1430
Tags: #daily
Links:

---

### 14:30 — help me refactor the search module
- 3 prompts in conversation
- Read: `lib/search.ts`
- Edited: `lib/search.ts`
- Ran: `npx tsc --noEmit`
- Vault search: "EEG"

**Topics discussed:**
- help me refactor the search module
- now test it against my vault
- looks good, update the docs

### 16:45 — what notes do I have about neuroimaging?
- Read: `Zettelkasten/Brain Atlases.md`
- Wrote: `Zettelkasten/fMRI Preprocessing.md`
- Vault search: "neuroimaging"

---
# References
```

Disable it by setting `dailySummary.enabled` to `false` in `vault.config.json`.

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
    "filenameFormat": "YYYY-MM-DD"
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

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) v0.50.0 or later
- An Obsidian vault (any folder of markdown files)
- Obsidian does **not** need to be running

## License

MIT
