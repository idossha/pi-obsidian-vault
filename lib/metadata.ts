import * as yaml from "yaml";
import type { MetadataConfig } from "./config.js";

export interface ParsedNote {
  metadata: Record<string, unknown>;
  body: string;
  hasMetadata: boolean;
  style: "yaml" | "plaintext" | "none";
}

// ── YAML Frontmatter ──────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseYamlFrontmatter(content: string): ParsedNote {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { metadata: {}, body: content, hasMetadata: false, style: "none" };
  }
  try {
    const metadata = yaml.parse(match[1]) || {};
    return { metadata, body: match[2], hasMetadata: true, style: "yaml" };
  } catch {
    return { metadata: {}, body: content, hasMetadata: false, style: "none" };
  }
}

function serializeYamlFrontmatter(
  metadata: Record<string, unknown>,
  body: string
): string {
  if (Object.keys(metadata).length === 0) return body;
  const yamlStr = yaml.stringify(metadata, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlStr}\n---\n${body}`;
}

// ── Plain-text Metadata ───────────────────────────────────────────────

function parsePlaintextMetadata(content: string): ParsedNote {
  const lines = content.split("\n");
  const metadata: Record<string, string> = {};
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Stop at separator or empty line that isn't followed by more metadata
    if (trimmed === "---") {
      bodyStart = i + 1;
      break;
    }
    if (trimmed === "") {
      // Check if next non-empty line is also a key: value
      let nextNonEmpty = i + 1;
      while (nextNonEmpty < lines.length && lines[nextNonEmpty].trim() === "") {
        nextNonEmpty++;
      }
      if (
        nextNonEmpty < lines.length &&
        /^[A-Za-z_]+\s*:/.test(lines[nextNonEmpty])
      ) {
        continue;
      }
      bodyStart = i;
      break;
    }

    const match = line.match(/^([A-Za-z_]+)\s*:\s*(.*)/);
    if (match) {
      metadata[match[1]] = match[2].trim();
    } else {
      // Not a metadata line — everything from here is body
      bodyStart = i;
      break;
    }
  }

  const hasMetadata = Object.keys(metadata).length > 0;
  const body = lines.slice(bodyStart).join("\n");
  return { metadata, body, hasMetadata, style: hasMetadata ? "plaintext" : "none" };
}

function serializePlaintextMetadata(
  metadata: Record<string, unknown>,
  body: string
): string {
  if (Object.keys(metadata).length === 0) return body;
  const lines = Object.entries(metadata).map(([k, v]) => `${k}: ${v ?? ""}`);
  return lines.join("\n") + "\n" + body;
}

// ── Unified API ───────────────────────────────────────────────────────

export function parseMetadata(
  content: string,
  config: MetadataConfig
): ParsedNote {
  if (config.style === "yaml") {
    return parseYamlFrontmatter(content);
  }
  return parsePlaintextMetadata(content);
}

export function serializeMetadata(
  metadata: Record<string, unknown>,
  body: string,
  config: MetadataConfig
): string {
  if (config.style === "yaml") {
    return serializeYamlFrontmatter(metadata, body);
  }
  return serializePlaintextMetadata(metadata, body);
}

export function updateMetadataField(
  content: string,
  key: string,
  value: unknown,
  config: MetadataConfig
): string {
  const parsed = parseMetadata(content, config);
  parsed.metadata[key] = value;
  return serializeMetadata(parsed.metadata, parsed.body, config);
}

export function deleteMetadataField(
  content: string,
  key: string,
  config: MetadataConfig
): string {
  const parsed = parseMetadata(content, config);
  if (!(key in parsed.metadata)) {
    throw new Error(`Metadata key not found: ${key}`);
  }
  delete parsed.metadata[key];
  return serializeMetadata(parsed.metadata, parsed.body, config);
}

/** Extract semantic fields using config field mappings */
export function getSemanticFields(
  metadata: Record<string, unknown>,
  config: MetadataConfig
): {
  created: string | null;
  status: string | null;
  tags: string[];
  links: string[];
} {
  const get = (key: string) => {
    const val = metadata[key];
    return val != null ? String(val) : null;
  };

  const created = get(config.fields.created);
  const status = get(config.fields.status);

  // Parse tags from either style
  const rawTags = metadata[config.fields.tags];
  let tags: string[] = [];
  if (Array.isArray(rawTags)) {
    tags = rawTags.map(String);
  } else if (typeof rawTags === "string" && rawTags.trim()) {
    // Plaintext: "#cs #programming" or "cs, programming"
    tags = rawTags
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean);
  }

  // Parse links
  const rawLinks = metadata[config.fields.links];
  let links: string[] = [];
  if (typeof rawLinks === "string" && rawLinks.trim()) {
    const linkMatches = rawLinks.match(/\[\[([^\]]+)\]\]/g);
    if (linkMatches) {
      links = linkMatches.map((l) => l.replace(/^\[\[|\]\]$/g, ""));
    }
  } else if (Array.isArray(rawLinks)) {
    links = rawLinks.map(String);
  }

  return { created, status, tags, links };
}
