/** @vitest-environment jsdom */
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationItemPopover } from "../../../src/renderer/components/annotation-item-popover";
import { AnnotationDraftPopover } from "../../../src/renderer/components/annotation-draft-popover";
import { requestAnnotationDismissal } from "../../../src/renderer/lib/annotation-dismissal";
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

function setup(
  onAdd: (annotation: Omit<Annotation, "id">) => void | boolean = vi.fn(),
  handoff = true,
) {
  function Surface() {
    const composer = useRef<HTMLTextAreaElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <textarea aria-label="Other composer" />
        <textarea ref={composer} aria-label="Originating composer" defaultValue="Unsent message" />
        <button onClick={() => setOpen(true)}>Selection action</button>
        <button onClick={() => setOpen(false)}>Navigate away</button>
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
describe("Annotation dismissal protection", () => {
  it("blocks the entire outside navigation click and preserves exact text, context and selection on Keep editing", async () => {
    const { user, input, onAdd } = setup();
    const text = "  Exact dictated or typed text\nsecond line  ";
    fireEvent.change(input, { target: { value: text } });
    (input as HTMLTextAreaElement).setSelectionRange(3, 12);
    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(input).toHaveProperty("value", text);
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("selectionStart", 3);
    expect(input).toHaveProperty("selectionEnd", 12);
    expect(input).toHaveProperty("value", text);
    await user.click(screen.getByRole("button", { name: "Add annotation" }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith({ ...selection, comment: text.trim() });
  });

  it("Escape asks, Escape in confirmation keeps editing, and deliberate Discard does not submit", async () => {
    const { user, input, onAdd } = setup();
    await user.type(input, "Keep me");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("value", "Keep me");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog", { name: "Add annotation" })).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("offers Submit without replaying the initiating outside click", async () => {
    const { user, input, composer, onAdd } = setup();
    await user.type(input, "Submit me");
    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith({ ...selection, comment: "Submit me" });
    expect(document.activeElement).toBe(composer);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each(["", "   "])(
    "dismisses an empty/whitespace draft without confirmation (%j)",
    async (text) => {
      const { user, input, onAdd } = setup();
      fireEvent.change(input, { target: { value: text } });
      await user.click(screen.getByRole("button", { name: "Navigate away" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(input.isConnected).toBe(false);
      expect(onAdd).not.toHaveBeenCalled();
    },
  );

  it("guards navigation shortcut requests and page teardown", async () => {
    const { user, input } = setup();
    await user.type(input, "Survive navigation");
    act(() => expect(requestAnnotationDismissal()).toBe(true));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    const event = new Event("beforeunload", { cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(input).toHaveProperty("value", "Survive navigation");
  });
});

describe("Existing annotation edits", () => {
  it.each(["outside", "Escape", "Cancel editing"])(
    "protects changed comments on %s",
    async (action) => {
      const save = vi.fn();
      const close = vi.fn();
      const user = userEvent.setup();
      render(
        <AnnotationItemPopover
          anchor={document.body}
          annotation={{ selectedText: "Original context", comment: "Saved note" }}
          onSave={save}
          onClose={close}
          onRemove={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Edit annotation" }));
      const input = screen.getByRole("textbox", { name: "Edit annotation comment" });
      fireEvent.change(input, { target: { value: "  Exact changed note\nwith spacing  " } });
      if (action === "outside") await user.click(document.body);
      else if (action === "Escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: action }));
      expect(screen.getByRole("alertdialog")).toBeDefined();
      expect(close).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(input).toHaveProperty("value", "  Exact changed note\nwith spacing  ");
      expect(document.activeElement).toBe(input);
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Submit" }));
      expect(save).toHaveBeenCalledExactlyOnceWith("Exact changed note\nwith spacing");
    },
  );
});

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

  it("keeps a rejected add editable rather than treating it as successful submission", async () => {
    const add = vi
      .fn<(annotation: Omit<Annotation, "id">) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const { user, input, composer } = setup(add);
    await user.type(input, "Do not lose a rejected annotation{Enter}");
    expect(input.isConnected).toBe(true);
    expect(input).toHaveProperty("value", "Do not lose a rejected annotation");
    expect(document.activeElement).toBe(input);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]).toEqual(add.mock.calls[0]);
    expect(document.activeElement).toBe(composer);
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
    expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Discard" }));
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
