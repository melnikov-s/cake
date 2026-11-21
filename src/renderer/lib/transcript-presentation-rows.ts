export interface TranscriptSectionView {
  todoId: string | undefined;
  start: boolean;
  key: string;
  expanded: boolean;
}

export interface TranscriptPresentationRow<T> {
  key: string;
  item: T;
  /** Index in the message collection, not the presentation rows. */
  index: number;
  kind: "message" | "section-space" | "task-heading" | "section-end";
  section: TranscriptSectionView | undefined;
}

/** Keep message identities intact while giving the virtualizer standalone sticky headings. */
export function transcriptPresentationRows<T>(
  items: readonly T[],
  keys: readonly string[],
  sections: readonly (TranscriptSectionView | undefined)[],
) {
  const rows: TranscriptPresentationRow<T>[] = [];
  const stickyIndices: number[] = [];
  const messageIndices: number[] = [];
  items.forEach((item, index) => {
    const key = keys[index]!;
    const section = sections[index];
    const row = { item, index, section };
    if (section?.start) {
      rows.push({ ...row, key: `${key}:section-space`, kind: "section-space" });
      stickyIndices.push(rows.length);
      rows.push({ ...row, key: `${key}:task-heading`, kind: "task-heading" });
    } else if (!section && sections[index - 1]) {
      // An empty sticky sentinel retires the previous label without attributing
      // the unlabelled messages to that task. Keep a measurable (1px) row.
      stickyIndices.push(rows.length);
      rows.push({ ...row, key: `${key}:section-end`, kind: "section-end" });
    }
    messageIndices.push(rows.length);
    rows.push({ ...row, key, kind: "message" });
  });
  return { rows, stickyIndices, messageIndices };
}

/**
 * Rows are rebuilt on every transcript render (a selection, hover or behavior
 * change), wrapping the same Pi parts in new group and row objects. Telling Legend
 * List those are the same rows keeps a re-render from counting as a data change:
 * each data change anchors the viewport to the row then in view, and that anchor
 * outlives an explicit scroll. A linked jump to a far, estimated message then
 * landed and was pulled back by the old anchor's growth (thousands of pixels).
 */
export function transcriptRowsEqual<T>(
  previous: TranscriptPresentationRow<T>,
  next: TranscriptPresentationRow<T>,
) {
  return (
    previous.key === next.key &&
    previous.kind === next.kind &&
    previous.index === next.index &&
    sameComposition(previous.section, next.section, 1) &&
    sameComposition(previous.item, next.item, 0)
  );
}

/** Renderer composition only spreads and wraps parts: compare wrappers, not part contents. */
function sameComposition(previous: unknown, next: unknown, depth: number): boolean {
  if (previous === next) return true;
  if (depth > 3 || typeof previous !== "object" || typeof next !== "object") return false;
  if (!previous || !next || Array.isArray(previous) !== Array.isArray(next)) return false;
  if (Array.isArray(previous) && Array.isArray(next))
    return (
      previous.length === next.length &&
      previous.every((value, index) => sameComposition(value, next[index], depth + 1))
    );
  const previousEntries = Object.entries(previous);
  return (
    previousEntries.length === Object.keys(next).length &&
    previousEntries.every(
      ([key, value]) =>
        Object.hasOwn(next, key) &&
        sameComposition(value, (next as Record<string, unknown>)[key], depth + 1),
    )
  );
}
