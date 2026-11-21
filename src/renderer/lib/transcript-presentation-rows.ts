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
export function transcriptRowsEqual<T>(sameItem: (previous: T, next: T) => boolean) {
  return (previous: TranscriptPresentationRow<T>, next: TranscriptPresentationRow<T>) =>
    previous.key === next.key &&
    previous.kind === next.kind &&
    previous.index === next.index &&
    sameSection(previous.section, next.section) &&
    sameItem(previous.item, next.item);
}

function sameSection(
  previous: TranscriptSectionView | undefined,
  next: TranscriptSectionView | undefined,
) {
  return (
    previous === next ||
    (previous !== undefined &&
      next !== undefined &&
      previous.key === next.key &&
      previous.todoId === next.todoId &&
      previous.start === next.start &&
      previous.expanded === next.expanded)
  );
}
