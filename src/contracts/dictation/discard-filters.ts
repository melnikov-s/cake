import { Schema } from "effect";

/** Shared edge normalization. Preserve case and internal punctuation/spacing. */
export function utteranceText(text: string): string {
  return text
    .trim()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "")
    .trim();
}

export const DictationDiscardFilter = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.makeFilter((text) => !!utteranceText(text), {
      message: "Enter words, not only punctuation or whitespace",
    }),
  ),
  matchCase: Schema.Boolean,
});
export interface DictationDiscardFilter extends Schema.Schema.Type<typeof DictationDiscardFilter> {}
export const DictationDiscardFilters = Schema.Array(DictationDiscardFilter);

export function matchesDiscardFilter(
  text: string,
  filters: ReadonlyArray<DictationDiscardFilter>,
): boolean {
  const spoken = utteranceText(text);
  return (
    !!spoken &&
    filters.some((filter) => {
      const rule = utteranceText(filter.text);
      return filter.matchCase ? spoken === rule : spoken.toLowerCase() === rule.toLowerCase();
    })
  );
}
