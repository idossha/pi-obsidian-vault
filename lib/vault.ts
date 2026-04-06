import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) {
      throw new Error(`Vault path does not exist: ${this.root}`);
    }
  }

  static discover(): Vault {
    // 1. Environment variable
    const envPath = process.env.OBSIDIAN_VAULT_PATH;
    if (envPath) return new Vault(envPath);

    // 2. Pi settings (project-local, then global)
    for (const settingsPath of [
      path.join(process.cwd(), ".pi", "settings.json"),
      path.join(os.homedir(), ".pi", "agent", "settings.json"),
    ]) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (settings.obsidianVault) return new Vault(settings.obsidianVault);
      } catch {
        // Settings file doesn't exist or is invalid
      }
    }

    throw new Error(
      "Obsidian vault path not configured. Set OBSIDIAN_VAULT_PATH environment variable " +
        'or add "obsidianVault": "/path/to/vault" to your Pi settings.json'
    );
  }

  resolve(relativePath: string): string {
    const cleaned = relativePath.replace(/^@/, "");
    const resolved = path.resolve(this.root, cleaned);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new Error(`Path escapes vault root: ${relativePath}`);
    }
    return resolved;
  }

  exists(relativePath: string): boolean {
    try {
      return fs.existsSync(this.resolve(relativePath));
    } catch {
      return false;
    }
  }

  read(relativePath: string): string {
    return fs.readFileSync(this.resolve(relativePath), "utf-8");
  }

  write(relativePath: string, content: string): void {
    const fullPath = this.resolve(relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  append(relativePath: string, content: string): void {
    const fullPath = this.resolve(relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Note does not exist: ${relativePath}`);
    }
    fs.appendFileSync(fullPath, content, "utf-8");
  }

  getAllMarkdownFiles(subdir?: string): string[] {
    const base = subdir ? this.resolve(subdir) : this.root;
    if (!fs.existsSync(base)) return [];
    const files: string[] = [];
    this.walkDir(base, files);
    return files.map((f) => path.relative(this.root, f));
  }

  private walkDir(dir: string, results: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(fullPath, results);
      } else if (entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  listDir(
    relativePath?: string,
    recursive?: boolean
  ): Array<{ name: string; type: "file" | "directory" }> {
    const base = relativePath ? this.resolve(relativePath) : this.root;
    if (!fs.existsSync(base)) {
      throw new Error(`Directory does not exist: ${relativePath || "/"}`);
    }
    const results: Array<{ name: string; type: "file" | "directory" }> = [];
    this.collectEntries(base, relativePath || "", recursive || false, results);
    return results;
  }

  private collectEntries(
    absDir: string,
    relPrefix: string,
    recursive: boolean,
    results: Array<{ name: string; type: "file" | "directory" }>
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push({ name: rel, type: "directory" });
        if (recursive) {
          this.collectEntries(path.join(absDir, entry.name), rel, true, results);
        }
      } else {
        results.push({ name: rel, type: "file" });
      }
    }
  }

  resolveWikilink(name: string): string | null {
    const cleanName = name.split("#")[0].split("|")[0].trim();
    if (!cleanName) return null;

    // Direct path match
    const withExt = cleanName.endsWith(".md") ? cleanName : `${cleanName}.md`;
    if (this.exists(withExt)) return withExt;

    // Search all markdown files for exact basename match
    const allFiles = this.getAllMarkdownFiles();
    const target = cleanName.toLowerCase();

    for (const file of allFiles) {
      const basename = path.basename(file, ".md").toLowerCase();
      if (basename === target) return file;
    }

    // Partial path match (e.g., "folder/note" matching "some/folder/note.md")
    for (const file of allFiles) {
      const withoutExt = file.replace(/\.md$/, "").toLowerCase();
      if (withoutExt.endsWith(target)) return file;
    }

    return null;
  }
}
