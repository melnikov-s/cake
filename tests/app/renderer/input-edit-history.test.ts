import { describe, expect, it } from "vitest";
import {
  InputEditHistory,
  type InputSelection,
} from "../../../src/renderer/lib/input-edit-history";

const selection = (value: string, start = value.length, end = start): InputSelection => ({
  value,
  start,
  end,
});

describe("input edit history", () => {
  it("groups continuous typing but separates deletion, paste, cut and selected replacement", () => {
    const history = new InputEditHistory(selection(""));
    history.record(selection(""), selection("a"), "insertText", 0);
    history.record(selection("a"), selection("ab"), "insertText", 1);
    history.record(selection("ab"), selection("a"), "deleteContentBackward", 2);
    expect(history.undo()?.value).toBe("ab");
    expect(history.undo()?.value).toBe("");
    expect(history.redo()?.value).toBe("ab");
    history.record(selection("ab", 0, 2), selection("paste"), "insertFromPaste", 3);
    expect(history.undo()).toEqual(selection("ab", 0, 2));
    expect(history.redo()?.value).toBe("paste");
    history.record(selection("paste", 0, 5), selection(""), "deleteByCut", 4);
    expect(history.undo()).toEqual(selection("paste", 0, 5));
    history.record(selection("paste", 0, 5), selection("x"), "insertText", 5);
    history.record(selection("x"), selection("xy"), "insertText", 6);
    expect(history.undo()).toEqual(selection("paste", 0, 5));
    expect(history.redo()?.value).toBe("xy");
  });

  it("groups one streamed replacement and preserves its original selection", () => {
    const original = { ...selection("Original draft", 0, 14), direction: "backward" as const };
    const history = new InputEditHistory(original);
    const group = Symbol();
    history.record(original, selection("Partial"), "replacement", 0, group);
    history.record(
      selection("Partial"),
      selection("Final replacement"),
      "replacement",
      9000,
      group,
    );
    expect(history.undo()).toEqual(original);
    expect(history.redo()).toEqual(selection("Final replacement"));
    expect(history.redo()).toBeUndefined();
  });

  it("does not join separate replacements and drops discarded replacements", () => {
    const history = new InputEditHistory(selection("draft"));
    const group = Symbol();
    history.record(selection("draft"), selection("partial"), "replacement", 0, group);
    history.record(selection("partial"), selection("draft"), "replacement", 1, group);
    expect(history.undo()).toBeUndefined();
    history.record(selection("draft"), selection("first"), "replacement", 2, Symbol());
    history.record(selection("first"), selection("second"), "replacement", 3, Symbol());
    expect(history.undo()?.value).toBe("first");
    expect(history.undo()?.value).toBe("draft");
  });

  it("breaks typing groups at caret movement and pauses; new edits clear redo", () => {
    const history = new InputEditHistory(selection(""));
    history.record(selection(""), selection("ab"), "insertText", 0);
    history.record(selection("ab", 0), selection("xab", 1), "insertText", 1);
    history.record(selection("xab", 1), selection("xyab", 2), "insertText", 2000);
    expect(history.undo()?.value).toBe("xab");
    expect(history.undo()?.value).toBe("ab");
    history.record(selection("ab"), selection("abc"), "insertText", 3000);
    expect(history.redo()).toBeUndefined();
  });

  it("never joins new typing into an edit preceding undo/redo", () => {
    const history = new InputEditHistory(selection(""));
    history.record(selection(""), selection("first"), "insertText", 0);
    history.undo();
    history.redo();
    history.record(selection("first"), selection("first next"), "insertText", 1);
    expect(history.undo()?.value).toBe("first");
    expect(history.undo()?.value).toBe("");
  });

  it("resets at draft ownership boundaries and never shares history between inputs", () => {
    const first = new InputEditHistory(selection("first"));
    const second = new InputEditHistory(selection("second"));
    first.record(selection("first"), selection("changed"), "replacement", 0);
    expect(second.undo()).toBeUndefined();
    first.reset(selection(""));
    expect(first.undo()).toBeUndefined();
    expect(first.redo()).toBeUndefined();
    first.record(selection(""), selection("next"), "insertText", 1);
    expect(first.undo()?.value).toBe("");
  });

  it("groups composition revisions as one edit even after a long pause", () => {
    const history = new InputEditHistory(selection("draft"));
    const group = Symbol();
    history.record(selection("draft"), selection("draft n"), "insertCompositionText", 0, group);
    history.record(
      selection("draft n"),
      selection("draft 你"),
      "insertCompositionText",
      2000,
      group,
    );
    expect(history.undo()?.value).toBe("draft");
    expect(history.redo()?.value).toBe("draft 你");
  });
});
