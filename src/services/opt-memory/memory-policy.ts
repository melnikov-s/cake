export const MEMORY_NODE_BYTES = 512;
/** One original's <input> per summary request. Larger originals send their head and tail;
 * the complete original stays available through zoom. */
export const MEMORY_INPUT_BYTES = 64_000;
export const memoryBytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Longest UTF-8-safe prefix (or suffix) of text within the byte limit. */
export function utf8Slice(text: string, bytes: number, from: "start" | "end" = "start") {
  const characters = Array.from(text);
  if (from === "end") characters.reverse();
  let used = 0;
  let count = 0;
  for (const character of characters) {
    const size = memoryBytes(character);
    if (used + size > bytes) break;
    used += size;
    count += 1;
  }
  const kept = characters.slice(0, count);
  return (from === "end" ? kept.reverse() : kept).join("");
}
