/** Word-preserving source spans for a punctuation classifier, not a transcript rewriter. */
export interface PunctuationWord {
  readonly before: string;
  readonly text: string;
  readonly protected: boolean;
}

export function punctuationWords(text: string): PunctuationWord[] {
  const words: PunctuationWord[] = [];
  let end = 0;
  let code = false;
  for (const match of text.matchAll(/\S+/gu)) {
    const source = match[0];
    const protectedWord =
      code ||
      source.includes("`") ||
      /[\\/@_=<>[\]{}]/u.test(source) ||
      /\d[.,]\d/u.test(source) ||
      /\.[\p{L}\p{N}]{1,8}[.!?,;:]*$/u.test(source) ||
      /[\p{Ll}][\p{Lu}]/u.test(source) ||
      /^[A-Z]{2,}/u.test(source);
    if ((source.match(/`/gu)?.length ?? 0) % 2) code = !code;
    words.push({
      before: text.slice(end, match.index),
      text: protectedWord ? source : source.replace(/[.!?,;:]+$/u, ""),
      protected: protectedWord || !/[\p{L}\p{N}]/u.test(source),
    });
    end = match.index + source.length;
  }
  return words;
}

/** Immediate preview while local inference runs; meaningful intra-word symbols stay intact. */
export function punctuationPreview(text: string): string {
  return punctuationWords(text)
    .map((word) => word.before + word.text)
    .join("")
    .trim();
}
