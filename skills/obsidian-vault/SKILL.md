---
name: obsidian-vault
description: Use when reading, writing, searching, or navigating notes in the user's Obsidian vault. Covers metadata styles (YAML and plaintext), wikilink syntax, template usage, and vault tool patterns.
---

# Obsidian Vault

You have access to the user's Obsidian vault through `vault_*` tools. These operate directly on the filesystem — Obsidian does not need to be running.

## Agent-Facing Tools

These tools are for the Pi harness/agent to use under the hood; they are not human slash commands.

- **vault_read** — Read a note by path or wikilink name
- **vault_write** — Create, overwrite, or append to a note (supports templates)
- **vault_search** — Full-text search across all notes (supports regex)
- **vault_list** — List files and directories
- **vault_tags** — List all tags or find notes by tag
- **vault_backlinks** — Find all notes linking to a given note
- **vault_metadata** — Read, set, or delete metadata fields (YAML or plaintext)

## Useful Slash Commands

- **/vault** — Show actionable vault status and relevant next commands
- **/vault:daily flush** — Summarize the current session immediately
- **/vault:init** — Generate `vault.config.json` from detected conventions

## Configuration

The extension reads `vault.config.json` from the vault root. If absent, it auto-detects conventions from `.obsidian/` settings and note sampling. Run `/vault:init` to generate a config file.

### Two Metadata Styles

**YAML frontmatter** (most common):
```yaml
---
tags:
  - topic
created: 2024-01-15
---
Content here
```

**Plaintext headers** (some vaults use this instead):
```
Created: 20240115 1030
Status: #in_progress
Tags: #topic
Links: [[Related Note]]

---
Content here
```

The config `metadata.style` determines which parser is used. The `metadata.fields` map tells the extension which plaintext key corresponds to which semantic role (created, status, tags, links).

## Wikilink Resolution

`vault_read` accepts a `name` parameter that resolves like Obsidian wikilinks:
- `name: "My Note"` finds `My Note.md` anywhere in the vault
- `name: "folder/My Note"` matches by partial path
- Exact basename match takes priority over partial path match

## Templates

When creating notes with `vault_write`, pass `template: "<name>"` to apply a configured template. Template names are defined in `vault.config.json` under `templates.noteTemplates`.

Core Obsidian template variables are expanded:
- `{{title}}` — note title (from filename)
- `{{date}}` / `{{date:FORMAT}}` — current date
- `{{time}}` / `{{time:FORMAT}}` — current time

## Obsidian Markdown Conventions

### Wikilinks
- `[[Note Name]]` — link to another note
- `[[Note Name|display text]]` — link with alias
- `[[Note Name#Heading]]` — link to a heading
- `[[Note Name#^block-id]]` — link to a block

### Embeds
- `![[Note Name]]` — embed a note
- `![[image.png]]` — embed an image

### Tags
- Inline: `#tag` or `#topic/subtopic` (hierarchical)
- In YAML frontmatter: `tags: [topic, other]`
- In plaintext metadata: `Tags: #topic #other`

### Callouts
```markdown
> [!note] Title
> Callout content
```
Types: note, tip, warning, danger, info, todo, example, quote, abstract, success, question, failure, bug

## Best Practices

1. Check the vault's metadata style before writing — use `vault_metadata` with `action: "read"` on an existing note if unsure
2. Use `vault_search` before creating a note to avoid duplicates
3. Use `vault_backlinks` to understand a note's context in the knowledge graph
4. Append rather than overwrite when adding to existing notes
5. Respect the vault's footer convention (e.g., `# References`) when creating notes
6. Use the configured template when creating notes matching a known type
