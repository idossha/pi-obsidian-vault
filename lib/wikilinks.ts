export interface WikilinkMatch {
  raw: string;
  target: string;
  heading?: string;
  block?: string;
  alias?: string;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const INLINE_TAG_RE = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/\-]*)/g;

export function extractWikilinks(content: string): WikilinkMatch[] {
  const matches: WikilinkMatch[] = [];
  let match;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const inner = match[1];
    const pipeIdx = inner.indexOf("|");
    const targetPart = pipeIdx >= 0 ? inner.slice(0, pipeIdx).trim() : inner.trim();
    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : undefined;

    let target = targetPart;
    let heading: string | undefined;
    let block: string | undefined;

    const blockIdx = targetPart.indexOf("#^");
    const headingIdx = blockIdx < 0 ? targetPart.indexOf("#") : -1;

    if (blockIdx >= 0) {
      target = targetPart.slice(0, blockIdx);
      block = targetPart.slice(blockIdx + 2);
    } else if (headingIdx >= 0) {
      target = targetPart.slice(0, headingIdx);
      heading = targetPart.slice(headingIdx + 1);
    }

    matches.push({ raw: match[0], target, heading, block, alias });
  }
  return matches;
}

export function extractInlineTags(content: string): string[] {
  // Strip code blocks and inline code
  const cleaned = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");

  // Strip frontmatter
  const withoutFm = cleaned.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

  const tags = new Set<string>();
  let match;
  while ((match = INLINE_TAG_RE.exec(withoutFm)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}
