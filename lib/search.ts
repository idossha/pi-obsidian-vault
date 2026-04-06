import type { Vault } from "./vault.js";

export interface SearchMatch {
  line: number;
  text: string;
  context: string[];
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
  score: number;
}

export function searchVault(
  vault: Vault,
  query: string,
  options: {
    pathFilter?: string;
    limit?: number;
    contextLines?: number;
    regex?: boolean;
  } = {}
): SearchResult[] {
  const { pathFilter, limit = 20, contextLines = 2, regex = false } = options;
  const files = vault.getAllMarkdownFiles(pathFilter);
  const results: SearchResult[] = [];

  let pattern: RegExp;
  if (regex) {
    try {
      pattern = new RegExp(query, "gi");
    } catch (e) {
      throw new Error(`Invalid regex: ${query}`);
    }
  }

  for (const file of files) {
    let content: string;
    try {
      content = vault.read(file);
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const matches: SearchMatch[] = [];

    for (let i = 0; i < lines.length; i++) {
      const isMatch = regex
        ? pattern!.test(lines[i])
        : lines[i].toLowerCase().includes(query.toLowerCase());

      if (regex) pattern!.lastIndex = 0;

      if (isMatch) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({
          line: i + 1,
          text: lines[i],
          context: lines.slice(start, end + 1),
        });
      }
    }

    if (matches.length > 0) {
      results.push({ path: file, matches, score: matches.length });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
