/** Medium-length cap for one-glance previews such as Activity rows. */
export const PREVIEW_MAX_CHARACTERS = 240;

/**
 * Single-paragraph preview of arbitrary text: whitespace runs (including newlines)
 * collapse to one space, and text longer than `maxCharacters` ends with an ellipsis.
 */
export function textPreview(text: string, maxCharacters = PREVIEW_MAX_CHARACTERS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxCharacters) return collapsed;
  // Keep surrogate pairs whole so the cut never renders a broken glyph.
  const cut = collapsed.slice(0, maxCharacters - 1).replace(/[\uD800-\uDBFF]$/, "");
  return `${cut.trimEnd()}…`;
}
