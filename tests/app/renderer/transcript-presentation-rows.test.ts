import { expect, it } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import {
  groupTranscriptParts,
  transcriptItemKeys,
} from "../../../src/renderer/components/chat-transcript-items";
import {
  transcriptPresentationRows,
  transcriptRowsEqual,
  type TranscriptSectionView,
} from "../../../src/renderer/lib/transcript-presentation-rows";

const section = (key: string, start: boolean, expanded = true): TranscriptSectionView => ({
  key,
  todoId: key,
  start,
  expanded,
});

it("keeps message identities and indices while retaining one sticky heading per section", () => {
  const items = ["a1", "a2", "b1", "a3"];
  const view = transcriptPresentationRows(items, items, [
    section("a", true),
    section("a", false),
    section("b", true),
    section("a-return", true),
  ]);
  expect(view.stickyIndices.map((index) => view.rows[index]?.key)).toEqual([
    "a1:task-heading",
    "b1:task-heading",
    "a3:task-heading",
  ]);
  expect(view.messageIndices.map((index) => view.rows[index])).toEqual(
    items.map((item, index) =>
      expect.objectContaining({ kind: "message", key: item, item, index }),
    ),
  );
});

it("retires a task label at an unlabelled boundary, not on every unlabelled message", () => {
  const items = ["intro", "a1", "general", "more", "b1"];
  const view = transcriptPresentationRows(items, items, [
    undefined,
    section("a", true),
    undefined,
    undefined,
    section("b", true),
  ]);
  expect(view.stickyIndices.map((index) => view.rows[index]?.kind)).toEqual([
    "task-heading",
    "section-end",
    "task-heading",
  ]);
  expect(view.rows.filter((row) => row.kind === "section-end").map((row) => row.item)).toEqual([
    "general",
  ]);
});

it("keeps folded sections independently actionable and leaves non-task transcripts unchanged", () => {
  const folded = transcriptPresentationRows(
    ["a", "b"],
    ["a", "b"],
    [section("a", true, false), section("b", true, false)],
  );
  expect(
    folded.rows.filter((row) => row.kind === "task-heading").map((row) => row.section?.expanded),
  ).toEqual([false, false]);
  const plain = transcriptPresentationRows(["one", "two"], ["one", "two"], []);
  expect(plain.messageIndices).toEqual([0, 1]);
  expect(plain.stickyIndices).toEqual([]);
  expect(plain.rows.map((row) => row.key)).toEqual(["one", "two"]);
});

// A selection or hover re-render rebuilds every group and row object around the same
// Pi parts. Legend List must see the same rows: a "data change" anchors the viewport
// to the row then in view, and that anchor pulled a far linked jump thousands of
// pixels off its target once the estimated rows above it were measured.
it("treats rows rebuilt around the same parts as unchanged, and real changes as changed", () => {
  const parts: UiPart[] = [
    { id: "question", kind: "text", role: "user", text: "Question", status: "complete" },
    {
      id: "file",
      kind: "attachment",
      name: "notes.md",
      mediaType: "text/markdown",
      attachmentKind: "file",
    },
    { id: "thinking", kind: "reasoning", text: "Reasoning", status: "complete" },
    { id: "answer", kind: "text", role: "assistant", text: "Answer", status: "complete" },
  ];
  const present = (source: UiPart[], expanded = true) => {
    const items = groupTranscriptParts(source);
    return transcriptPresentationRows(
      items,
      transcriptItemKeys(items),
      items.map((_, index) => section("task", index === 0, expanded)),
    ).rows;
  };
  const before = present(parts);
  const after = present(parts);
  // The user turn wraps its attachment and the Work log groups its reasoning anew.
  expect(after.filter((row, index) => row.item !== before[index]!.item).length).toBeGreaterThan(0);
  expect(after.every((row, index) => transcriptRowsEqual(before[index]!, row))).toBe(true);

  const edited = present(
    parts.map((part) => (part.id === "answer" ? { ...part, text: "New" } : part)),
  );
  expect(edited.map((row, index) => transcriptRowsEqual(before[index]!, row))).toEqual(
    before.map((row) => row.item !== parts[3]),
  );
  const folded = present(parts, false);
  expect(folded.some((row, index) => !transcriptRowsEqual(before[index]!, row))).toBe(true);
});
