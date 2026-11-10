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
