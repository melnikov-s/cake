/** @vitest-environment jsdom */
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationDraftPopover } from "../../../src/renderer/components/annotation-draft-popover";
import type { Annotation } from "../../../src/contracts/conversations/session-contract";

const selection = {
  messageId: "assistant-1",
  entryId: "entry-1",
  artifactId: "artifact-1",
  selectedText: "Selected code",
  startOffset: 2,
  endOffset: 15,
  contextBefore: "A ",
  contextAfter: " sample",
};

afterEach(cleanup);

function setup(onAdd = vi.fn<(annotation: Omit<Annotation, "id">) => void>(), handoff = true) {
  function Surface() {
    const composer = useRef<HTMLTextAreaElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <textarea aria-label="Other composer" />
        <textarea ref={composer} aria-label="Originating composer" defaultValue="Unsent message" />
        <button onClick={() => setOpen(true)}>Selection action</button>
        {open && (
          <AnnotationDraftPopover
            anchor={{ top: 0, left: 0, right: 20, bottom: 20 }}
            selection={selection}
            submitFocusRef={handoff ? composer : undefined}
            onAdd={onAdd}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }
  render(<Surface />);
  const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Originating composer",
  });
  composer.setSelectionRange(composer.value.length, composer.value.length);
  const action = screen.getByRole("button", { name: "Selection action" });
  action.focus();
  fireEvent.click(action);
  return {
    user: userEvent.setup(),
    onAdd,
    input: screen.getByRole("textbox", { name: "Annotation comment" }),
    composer,
  };
}

// Primitive lifecycle/contract coverage only. Native selection and keyboard focus
// must additionally be checked in the isolated Electron message-selection suite.
describe("Annotation submission focus handoff", () => {
  for (const submit of ["Enter", "button"] as const) {
    it(`hands off only after successful ${submit} submission, preserving the annotation`, async () => {
      const { user, input, composer, onAdd } = setup();
      await user.type(input, "  Remember this");
      await user.keyboard("{Shift>}{Enter}{/Shift}second line  ");
      expect(document.activeElement).toBe(input);
      expect(onAdd).not.toHaveBeenCalled();
      if (submit === "Enter") await user.keyboard("{Enter}");
      else await user.click(screen.getByRole("button", { name: "Add annotation" }));
      expect(onAdd).toHaveBeenCalledExactlyOnceWith({
        ...selection,
        comment: "Remember this\nsecond line",
      });
      expect(screen.queryByRole("dialog", { name: "Add annotation" })).toBeNull();
      expect(document.activeElement).toBe(composer);
      expect(composer).toHaveProperty("value", "Unsent message");
      await user.keyboard(" plus context");
      expect(composer).toHaveProperty("value", "Unsent message plus context");
    });
  }

  it("does not hand off for Shift+Enter or IME composition", async () => {
    const { user, input, onAdd } = setup();
    await user.type(input, "Note");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onAdd).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("value", "Note\n");
  });

  it("keeps a failed add editable and allows retry without losing the comment", async () => {
    const failure = new Error("Annotation add failed");
    const onAdd = vi
      .fn<(annotation: Omit<Annotation, "id">) => void>()
      .mockImplementationOnce(() => {
        throw failure;
      });
    const { user, input, composer } = setup(onAdd);
    await user.type(input, "Retain this note");
    const errors: unknown[] = [];
    const recordError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", recordError);
    try {
      fireEvent.submit(input.closest("form")!);
    } finally {
      window.removeEventListener("error", recordError);
    }
    expect(errors).toEqual([failure]);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("value", "Retain this note");
    expect(screen.getByRole("dialog", { name: "Add annotation" })).toBeDefined();
    await user.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd.mock.calls[1]).toEqual(onAdd.mock.calls[0]);
    expect(document.activeElement).toBe(composer);
  });

  it("keeps ordinary cancellation and other popover consumers on their existing focus path", async () => {
    const { user, input, onAdd } = setup();
    await user.type(input, "Do not add");
    await user.keyboard("{Escape}");
    expect(onAdd).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(
      screen.getByRole("textbox", { name: "Originating composer" }),
    );
    cleanup();
    const standalone = setup(undefined, false);
    await standalone.user.type(standalone.input, "Standalone note");
    await standalone.user.keyboard("{Enter}");
    expect(standalone.onAdd).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(standalone.composer);
  });
});
