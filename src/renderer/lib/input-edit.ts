import type { ComposerInputElement } from "./composer-input-element";
import type { InputSelection } from "./input-edit-history";

const edits = new WeakMap<Event, { before: InputSelection; group?: symbol }>();

export function inputSelection(element: ComposerInputElement): InputSelection {
  const selection: InputSelection = {
    value: element.value,
    start: element.selectionStart,
    end: element.selectionEnd,
  };
  if (element instanceof HTMLTextAreaElement) selection.direction = element.selectionDirection;
  return selection;
}

export function inputEditDetails(event: Event) {
  return edits.get(event);
}

/** Publish an application edit through the same input boundary as typing/cut/paste. */
export function applyInputEdit(
  element: ComposerInputElement,
  next: InputSelection,
  group?: symbol,
) {
  const before = inputSelection(element);
  // Bypass React's value tracker so the input event reaches its controlled onChange.
  if (element instanceof HTMLTextAreaElement)
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      element,
      next.value,
    );
  else element.value = next.value;
  element.setSelectionRange(next.start, next.end);
  if (element instanceof HTMLTextAreaElement && next.direction)
    element.setSelectionRange(next.start, next.end, next.direction);
  const event = new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" });
  edits.set(event, { before, group });
  element.dispatchEvent(event);
}
