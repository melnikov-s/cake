import { parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";

const OPEN = "<cake-todo>";
const CLOSE = "</cake-todo>";

/** An unfinished envelope owns only its JSON prefix, never unrelated following prose. */
function unfinishedEnd(text: string): number {
  if (!text.trimStart().startsWith("{")) return text.length - text.trimStart().length;
  const errors: ParseError[] = [];
  const node = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  const unexpected = errors.find((error) => {
    // EOF and an unterminated string are normal while receiving a JSON prefix.
    const code = printParseErrorCode(error.error);
    if (error.offset >= text.length || code === "UnexpectedEndOfString") return false;
    const tail = text.slice(error.offset).trim();
    if (code === "InvalidSymbol" && ["true", "false", "null"].some((s) => s.startsWith(tail)))
      return false;
    return true;
  });
  let end = Math.min(
    unexpected?.offset ?? text.length,
    node ? node.offset + node.length : text.length,
  );
  if (unexpected) while (end > 0 && /\s/.test(text[end - 1] ?? "")) end -= 1;
  return end;
}

/** Complete envelopes can span text slots; unfinished ones stop at non-text boundaries. */
function hiddenRanges(
  text: string,
  streaming: boolean,
  boundaries: ReadonlySet<number>,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let code: { char: string; length: number } | undefined;
  for (let i = 0; i < text.length;) {
    if (boundaries.has(i)) code = undefined;
    const char = text[i];
    const boundary =
      char === "<" ? ([...boundaries].find((offset) => offset > i) ?? text.length) : text.length;
    if (char === "`" || char === "~") {
      let end = i + 1;
      while (text[end] === char) end += 1;
      const length = end - i;
      if (code) {
        if (
          char === code.char &&
          (length === code.length || (code.length >= 3 && length > code.length))
        )
          code = undefined;
      } else if (char === "`" || length >= 3) code = { char, length };
      i = end;
    } else if (code) i += 1;
    else if (char === "\\") i += 2;
    else if (char === '"') {
      // JSON string values and quoted examples are content, not protocol envelopes.
      i += 1;
      while (i < text.length && !boundaries.has(i)) {
        if (text[i] === "\\") i += 2;
        else if (text[i++] === '"') break;
      }
    } else if (text.startsWith(OPEN, i)) {
      const body = i + OPEN.length;
      const close = text.indexOf(CLOSE, body);
      let end: number;
      if (close !== -1) end = close + CLOSE.length;
      else {
        const bodyBoundary = [...boundaries].find((offset) => offset >= body) ?? text.length;
        end = body + unfinishedEnd(text.slice(body, bodyBoundary));
        // A JSON object may finish before the closing tag arrives, or the tag
        // may never arrive. Suppress only an actual (possibly split) close tag.
        let tag = end;
        while (/\s/.test(text[tag] ?? "") && tag < bodyBoundary) tag += 1;
        if (CLOSE.startsWith(text.slice(tag, bodyBoundary)) && tag < bodyBoundary)
          end = bodyBoundary;
      }
      ranges.push([i, end]);
      i = end;
    } else if (
      char === "<" &&
      OPEN.startsWith(text.slice(i, boundary)) &&
      (streaming || text.slice(i, boundary).startsWith("<cake-"))
    ) {
      ranges.push([i, boundary]);
      i = boundary;
    } else i += 1;
  }
  return ranges;
}

function blockText(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null || Reflect.get(block, "type") !== "text")
    return undefined;
  const text = Reflect.get(block, "text");
  return typeof text === "string" ? text : undefined;
}

/** Preserve block indices/signatures and non-text blocks; never mutate originals. */
export function visibleTaskAttributionContent<T>(content: readonly T[], streaming = false): T[] {
  const boundaries = new Set<number>();
  let text = "";
  for (const block of content) {
    const value = blockText(block);
    if (value === undefined) boundaries.add(text.length);
    else text += value;
  }
  const ranges = hiddenRanges(text, streaming, boundaries);
  let offset = 0;
  return content.map((block) => {
    const original = blockText(block);
    if (original === undefined) return block;
    let visible = "";
    let cursor = offset;
    const limit = offset + original.length;
    for (const [from, to] of ranges) {
      if (to <= cursor || from >= limit) continue;
      visible += text.slice(cursor, Math.max(cursor, from));
      cursor = Math.min(limit, to);
    }
    visible += text.slice(cursor, limit);
    offset = limit;
    return typeof block === "object" && block !== null && visible !== original
      ? { ...block, text: visible }
      : block;
  });
}
