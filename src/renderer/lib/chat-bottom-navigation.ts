/**
 * Resolve the focused chat's explicit bottom control, never a sibling/nested chat
 * or a text editor. An empty composer has no caret navigation to preserve.
 */
export function chatBottomNavigationTarget(
  target: EventTarget | null,
): HTMLButtonElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const pane = target.closest('[data-slot="chat"]');
  if (!pane) return undefined;
  const editable = target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  );
  if (editable) {
    if (
      !(editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) ||
      !editable.matches('.workbench-composer [role="combobox"]') ||
      editable.value !== ""
    )
      return undefined;
  }
  return [...pane.querySelectorAll<HTMLButtonElement>("[data-chat-scroll-to-bottom]")].find(
    (button) => !button.disabled && button.closest('[data-slot="chat"]') === pane,
  );
}
