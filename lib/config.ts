import * as fs from "node:fs";
import * as path from "node:path";

export interface FolderConfig {
  notes: string;
  hubs: string | null;
  templates: string;
  attachments: string;
  daily: string | null;
  inbox: string | null;
  archive: string | null;
  projects: string | null;
}

export interface MetadataFieldConfig {
  created: string;
  status: string;
  tags: string;
  links: string;
}

export interface MetadataConfig {
  style: "yaml" | "plaintext";
  fields: MetadataFieldConfig;
  dateFormat: string;
}

export interface TemplatesConfig {
  engine: "core" | "templater";
  dateFormat: string;
  timeFormat: string;
  noteTemplates: Record<string, string>;
}

export interface ConventionsConfig {
  naming: "title-case" | "kebab-case" | "date-prefixed" | "uid-prefixed";
  tagStyle: "flat" | "hierarchical";
  footer: string | null;
}

export interface DailySummaryConfig {
  enabled: boolean;
  folder: string;
  filenameFormat: string;
}

export interface VaultConfig {
  folders: FolderConfig;
  metadata: MetadataConfig;
  templates: TemplatesConfig;
  conventions: ConventionsConfig;
  dailySummary: DailySummaryConfig;
}

const DEFAULT_CONFIG: VaultConfig = {
  folders: {
    notes: "",
    hubs: null,
    templates: "Templates",
    attachments: "Attachments",
    daily: null,
    inbox: null,
    archive: null,
    projects: null,
  },
  metadata: {
    style: "yaml",
    fields: {
      created: "created",
      status: "status",
      tags: "tags",
      links: "links",
    },
    dateFormat: "YYYY-MM-DD",
  },
  templates: {
    engine: "core",
    dateFormat: "YYYY-MM-DD",
    timeFormat: "HH:mm",
    noteTemplates: {},
  },
  conventions: {
    naming: "title-case",
    tagStyle: "flat",
    footer: null,
  },
  dailySummary: {
    enabled: true,
    folder: "Daily",
    filenameFormat: "YYYY-MM-DD",
  },
};

export function loadConfig(vaultRoot: string): VaultConfig {
  const configPath = path.join(vaultRoot, "vault.config.json");
  if (!fs.existsSync(configPath)) {
    return detectConfig(vaultRoot);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return detectConfig(vaultRoot);
  }
}

function mergeConfig(defaults: VaultConfig, overrides: Partial<VaultConfig>): VaultConfig {
  return {
    folders: { ...defaults.folders, ...overrides.folders },
    metadata: {
      ...defaults.metadata,
      ...overrides.metadata,
      fields: { ...defaults.metadata.fields, ...overrides.metadata?.fields },
    },
    templates: { ...defaults.templates, ...overrides.templates },
    conventions: { ...defaults.conventions, ...overrides.conventions },
    dailySummary: { ...defaults.dailySummary, ...overrides.dailySummary },
  };
}

/** Auto-detect vault conventions from .obsidian/ settings and file sampling */
export function detectConfig(vaultRoot: string): VaultConfig {
  const config: VaultConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Read Obsidian settings
  const appJsonPath = path.join(vaultRoot, ".obsidian", "app.json");
  if (fs.existsSync(appJsonPath)) {
    try {
      const app = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));

      if (app.newFileFolderPath) {
        config.folders.notes = app.newFileFolderPath;
      }
      if (app.attachmentFolderPath) {
        config.folders.attachments = app.attachmentFolderPath;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Read template folder from Obsidian
  const templatesJsonPath = path.join(vaultRoot, ".obsidian", "templates.json");
  if (fs.existsSync(templatesJsonPath)) {
    try {
      const tmpl = JSON.parse(fs.readFileSync(templatesJsonPath, "utf-8"));
      if (tmpl.folder) {
        config.folders.templates = tmpl.folder;
      }
    } catch {
      // Ignore
    }
  }

  // Detect common folder patterns
  const topDirs = getTopLevelDirs(vaultRoot);
  const dirSet = new Set(topDirs.map((d) => d.toLowerCase()));

  for (const name of ["hubs", "mocs", "maps", "atlas", "indexes"]) {
    if (dirSet.has(name)) {
      config.folders.hubs = topDirs.find((d) => d.toLowerCase() === name) || null;
      break;
    }
  }
  for (const name of ["daily", "journal", "calendar"]) {
    if (dirSet.has(name)) {
      config.folders.daily = topDirs.find((d) => d.toLowerCase() === name) || null;
      break;
    }
  }
  for (const name of ["inbox", "+ inbox", "capture"]) {
    if (dirSet.has(name)) {
      config.folders.inbox = topDirs.find((d) => d.toLowerCase() === name) || null;
      break;
    }
  }
  for (const name of ["archive", "zarchive"]) {
    if (dirSet.has(name)) {
      config.folders.archive = topDirs.find((d) => d.toLowerCase() === name) || null;
      break;
    }
  }
  for (const name of ["projects", "efforts"]) {
    if (dirSet.has(name)) {
      config.folders.projects = topDirs.find((d) => d.toLowerCase() === name) || null;
      break;
    }
  }

  // Detect metadata style by sampling notes
  const metadataStyle = detectMetadataStyle(vaultRoot, config.folders.notes);
  config.metadata.style = metadataStyle.style;
  if (metadataStyle.style === "plaintext") {
    config.metadata.fields = metadataStyle.fields;
    config.metadata.dateFormat = metadataStyle.dateFormat;
  }

  // Detect templates
  const templateDir = path.join(vaultRoot, config.folders.templates);
  if (fs.existsSync(templateDir)) {
    try {
      const templateFiles = fs.readdirSync(templateDir).filter((f) => f.endsWith(".md"));
      for (const file of templateFiles) {
        const name = file.replace(/\.md$/, "").toLowerCase().replace(/\s+/g, "-");
        config.templates.noteTemplates[name] = file;
      }
    } catch {
      // Ignore
    }

    // Check for Templater syntax in templates
    for (const file of Object.values(config.templates.noteTemplates)) {
      try {
        const content = fs.readFileSync(path.join(templateDir, file), "utf-8");
        if (content.includes("<%") && content.includes("%>")) {
          config.templates.engine = "templater";
          break;
        }
      } catch {
        // Ignore
      }
    }
  }

  // Detect date/time format from templates
  const templateFiles = Object.values(config.templates.noteTemplates);
  for (const file of templateFiles) {
    try {
      const content = fs.readFileSync(path.join(vaultRoot, config.folders.templates, file), "utf-8");
      const dateMatch = content.match(/\{\{date:([^}]+)\}\}/);
      const timeMatch = content.match(/\{\{time:([^}]+)\}\}/);
      if (dateMatch) config.templates.dateFormat = dateMatch[1];
      if (timeMatch) config.templates.timeFormat = timeMatch[1];
      break;
    } catch {
      // Ignore
    }
  }

  // Detect footer convention by sampling
  config.conventions.footer = detectFooter(vaultRoot, config.folders.notes);

  return config;
}

function getTopLevelDirs(vaultRoot: string): string[] {
  try {
    return fs
      .readdirSync(vaultRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface DetectedMetadata {
  style: "yaml" | "plaintext";
  fields: MetadataFieldConfig;
  dateFormat: string;
}

function detectMetadataStyle(vaultRoot: string, notesFolder: string): DetectedMetadata {
  const dir = notesFolder ? path.join(vaultRoot, notesFolder) : vaultRoot;
  const result: DetectedMetadata = {
    style: "yaml",
    fields: { created: "created", status: "status", tags: "tags", links: "links" },
    dateFormat: "YYYY-MM-DD",
  };

  let mdFiles: string[];
  try {
    mdFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .slice(0, 20);
  } catch {
    return result;
  }

  let yamlCount = 0;
  let plaintextCount = 0;
  const fieldKeys = new Map<string, number>();

  for (const file of mdFiles) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const firstLine = content.split("\n")[0].trim();

      if (firstLine === "---") {
        yamlCount++;
      } else if (/^[A-Za-z_]+\s*:/.test(firstLine)) {
        plaintextCount++;
        // Collect field names
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.trim() === "---") break;
          if (line.trim() === "") break;
          const match = line.match(/^([A-Za-z_]+)\s*:/);
          if (match) {
            const key = match[1];
            fieldKeys.set(key, (fieldKeys.get(key) || 0) + 1);
          }
        }
      }
    } catch {
      continue;
    }
  }

  if (plaintextCount > yamlCount) {
    result.style = "plaintext";
    // Map detected field names to their semantic roles
    for (const [key] of fieldKeys) {
      const lower = key.toLowerCase();
      if (lower.includes("creat") || lower === "date") result.fields.created = key;
      else if (lower.includes("status")) result.fields.status = key;
      else if (lower.includes("tag")) result.fields.tags = key;
      else if (lower.includes("link")) result.fields.links = key;
    }

    // Detect date format from Created field values
    for (const file of mdFiles.slice(0, 5)) {
      try {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const match = content.match(new RegExp(`^${result.fields.created}\\s*:\\s*(.+)`, "m"));
        if (match) {
          const val = match[1].trim();
          if (/^\d{8}\s+\d{4}$/.test(val)) {
            result.dateFormat = "YYYYMMDD HHmm";
          } else if (/^\d{8}\s*,\s*\d{4}$/.test(val)) {
            result.dateFormat = "YYYYMMDD , HHmm";
          } else if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
            result.dateFormat = "YYYY-MM-DD";
          }
          break;
        }
      } catch {
        continue;
      }
    }
  }

  return result;
}

function detectFooter(vaultRoot: string, notesFolder: string): string | null {
  const dir = notesFolder ? path.join(vaultRoot, notesFolder) : vaultRoot;
  const footerCounts = new Map<string, number>();

  let mdFiles: string[];
  try {
    mdFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .slice(0, 30);
  } catch {
    return null;
  }

  for (const file of mdFiles) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const lines = content.trimEnd().split("\n");
      // Check last non-empty line
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (line.startsWith("#")) {
          footerCounts.set(line, (footerCounts.get(line) || 0) + 1);
        }
        break;
      }
    } catch {
      continue;
    }
  }

  // If a footer appears in >50% of sampled files, it's a convention
  for (const [footer, count] of footerCounts) {
    if (count > mdFiles.length * 0.5) return footer;
  }
  return null;
}

export function generateConfigFile(vaultRoot: string): string {
  const config = detectConfig(vaultRoot);
  return JSON.stringify(config, null, 2);
}
