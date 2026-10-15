/**
 * Keyboard rules for transcript message selection.
 *
 * A Chat pane handles these keys only when DOM focus is inside that pane, so
 * split panes never react to each other's keys. Within the pane:
 *
 * - ArrowUp selects the previous assistant message (the newest one when nothing
 *   is selected). ArrowDown moves to the next one; past the newest it clears the
 *   selection. ArrowDown with nothing selected is left alone.
 * - Escape clears an existing selection, ahead of the composer's stop/dismiss.
 * - Keys with Shift, Alt, Ctrl, or Meta, IME composition, and keys another
 *   handler already consumed (such as an app hotkey) are never taken.
 * - In the pane's own composer the arrows are taken only while it is empty, so
 *   caret movement, multi-line editing, and slash/file menus keep their arrows.
 *   Escape is taken there whenever a selection exists.
 * - Any other text field, and widgets that navigate with arrows themselves
 *   (listbox, menu, tabs, radio groups, sliders, grids, trees), keep every key.
 * - Elsewhere in the pane (transcript content, the focused transcript scroller,
 *   buttons, the parked dictation focus anchor) the keys select messages.
 */
export type MessageSelectionKeyAction = "select-previous" | "select-next" | "clear";

const editableSelector = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const arrowWidgetSelector =
  '[role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="grid"], [role="tree"], [role="combobox"], [role="spinbutton"]';

export interface MessageSelectionKeyContext {
  /** The Chat pane root. Keys whose target is outside it, including portals, are ignored. */
  pane: Element;
  /** The pane's composer text input, if mounted. */
  composerInput: HTMLTextAreaElement | null;
  hasSelection: boolean;
}

export function messageSelectionKeyAction(
  event: Pick<
    KeyboardEvent,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "defaultPrevented"
  > & { target: EventTarget | null },
  context: MessageSelectionKeyContext,
): MessageSelectionKeyAction | undefined {
  if (event.defaultPrevented || event.isComposing) return undefined;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  const action =
    event.key === "ArrowUp"
      ? "select-previous"
      : event.key === "ArrowDown" && context.hasSelection
        ? "select-next"
        : event.key === "Escape" && context.hasSelection
          ? "clear"
          : undefined;
  if (!action) return undefined;
  const target = event.target;
  if (!(target instanceof Element) || !context.pane.contains(target)) return undefined;
  // A nested Chat owns its own keys.
  if (target.closest('[data-slot="chat"]') !== context.pane) return undefined;
  if (target === context.composerInput)
    return action === "clear" || context.composerInput.value === "" ? action : undefined;
  if (target.closest(editableSelector) || target.closest(arrowWidgetSelector)) return undefined;
  return action;
}
