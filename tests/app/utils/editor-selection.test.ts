import { describe, expect, it } from "vitest";
import {
  discussionAnchorFromEditorSelection,
  sourceAttachmentFromEditorSelection,
} from "../../../src/utils/editor-selection";

const selection = {
  path: "src/main.ts",
  startLine: 4,
  startColumn: 2,
  endLine: 5,
  endColumn: 8,
  selectedText: "const answer =\n  calculate();",
  contextBefore: "function run() {",
  contextAfter: "}",
};

describe("editor selection conversions", () => {
  it("anchors a code discussion at the exact one-based lines and zero-based columns", () => {
    expect(discussionAnchorFromEditorSelection(selection)).toEqual({
      path: "src/main.ts",
      view: "file",
      start: { diffLine: 4, oldLine: 5, newLine: 5, column: 2 },
      end: { diffLine: 5, oldLine: 6, newLine: 6, column: 8 },
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
      diff: "",
    });
  });

  it("builds a source annotation with the quoted code and a trimmed note", () => {
    expect(sourceAttachmentFromEditorSelection(selection, "  Why is this here?  ")).toEqual({
      kind: "source",
      name: "src/main.ts",
      location: { path: "src/main.ts", range: { start: { line: 4 }, end: { line: 5 } } },
      selectedText: "const answer =\n  calculate();",
      comment: "Why is this here?",
    });
  });

  it("omits an empty note and folds a whole-line selection's trailing line break", () => {
    const attachment = sourceAttachmentFromEditorSelection(
      { ...selection, startColumn: 0, endLine: 6, endColumn: 0 },
      "   ",
    );
    expect(attachment).not.toHaveProperty("comment");
    expect(attachment.location.range).toEqual({ start: { line: 4 }, end: { line: 5 } });
  });
});
