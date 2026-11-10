import { expect, it } from "vitest";
import {
  transcriptPresentationRows,
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
