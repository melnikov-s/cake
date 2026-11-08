/** @vitest-environment jsdom */
import { StrictMode, useLayoutEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { SlashCommandCombobox } from "../../../src/renderer/components/slash-command-combobox";
import { applyInputEdit } from "../../../src/renderer/lib/input-edit";

afterEach(cleanup);

function Editor({
  value,
  revision = 0,
  name = "Draft",
}: {
  value: string;
  revision?: number;
  name?: string;
}) {
  const [draft, setDraft] = useState(value);
  useLayoutEffect(() => setDraft(value), [value]);
  return (
    <SlashCommandCombobox
      commands={[]}
      value={draft}
      onValueChange={setDraft}
      onSubmit={() => {}}
      inputHistoryRevision={revision}
      aria-label={name}
      dictation={false}
      focusEnabled={false}
    />
  );
}

// Supplemental controlled-write/boundary proof. Real native editing/selection is verified in Electron.
it("restores controlled replacements and clears both stacks on a new draft boundary in Strict Mode", async () => {
  const view = render(
    <StrictMode>
      <Editor value="Original" />
    </StrictMode>,
  );
  const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Draft" });
  const user = userEvent.setup();
  await user.click(input);
  input.setSelectionRange(0, 8, "backward");
  fireEvent.select(input);
  view.rerender(
    <StrictMode>
      <Editor value="Replacement" />
    </StrictMode>,
  );
  expect(input.value).toBe("Replacement");
  fireEvent.keyDown(input, { key: "z", metaKey: true });
  expect(input.value).toBe("Original");
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
    0,
    8,
    "backward",
  ]);
  fireEvent.keyDown(input, { key: "z", shiftKey: true, metaKey: true });
  expect(input.value).toBe("Replacement");
  view.rerender(
    <StrictMode>
      <Editor value="Other editing target" revision={1} />
    </StrictMode>,
  );
  fireEvent.keyDown(input, { key: "z", metaKey: true });
  fireEvent.keyDown(input, { key: "y", ctrlKey: true });
  expect(input.value).toBe("Other editing target");
});

it("groups application revisions, then ordinary typing/deletion, without sharing input history", async () => {
  render(
    <>
      <Editor value="Original draft" />
      <Editor value="Independent" name="Other" />
    </>,
  );
  const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Draft" });
  const other = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Other" });
  const group = Symbol();
  input.setSelectionRange(0, input.value.length);
  act(() => {
    applyInputEdit(input, { value: "Partial", start: 7, end: 7 }, group);
    applyInputEdit(input, { value: "Final", start: 5, end: 5 }, group);
  });
  fireEvent.keyDown(other, { key: "z", metaKey: true });
  expect(other.value).toBe("Independent");
  fireEvent.keyDown(input, { key: "z", metaKey: true });
  expect(input.value).toBe("Original draft");
  fireEvent.keyDown(input, { key: "z", shiftKey: true, metaKey: true });
  expect(input.value).toBe("Final");
  const user = userEvent.setup();
  await user.type(input, " text{Backspace}");
  expect(input.value).toBe("Final tex");
  fireEvent.keyDown(input, { key: "z", metaKey: true });
  expect(input.value).toBe("Final text");
  fireEvent.keyDown(input, { key: "z", metaKey: true });
  expect(input.value).toBe("Final");
  expect(other.value).toBe("Independent");
});
