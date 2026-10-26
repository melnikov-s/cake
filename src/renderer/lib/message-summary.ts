const maxSummaryCharacters = 240;

/**
 * Plain text from the start of a Markdown message, for a collapsed one-line preview.
 * Code fences, rules, tables and HTML are skipped; inline markup is reduced to its text.
 */
export function markdownSummary(markdown: string): string | undefined {
  const words: string[] = [];
  let length = 0;
  let fenced = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || /^(---+|\*\*\*+|___+|\||<)/.test(line)) continue;
    const text = line
      .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|~~|`/g, "")
      .replace(/(^|\s)\*(?=\S)|(?<=\S)\*(?=\s|$)/g, "$1")
      .trim();
    if (!text) continue;
    words.push(text);
    length += text.length + 1;
    if (length >= maxSummaryCharacters) break;
  }
  return words.length ? words.join(" ").slice(0, maxSummaryCharacters) : undefined;
}
