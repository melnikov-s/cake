import { useEffect } from "react";

const popupSelector = '[role="dialog"], [role="alertdialog"], [role="menu"]';
const chatSelector = '[data-slot="chat"][data-composer-focus-enabled="true"]';
const inputSelector =
  'textarea:not(:disabled):not([readonly]), input:not(:disabled):not([readonly]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"]), [contenteditable="true"]';
const nativeTabSelector = "iframe, webview, .xterm, .monaco-editor, .cm-editor";

function visible(element: HTMLElement) {
  return (
    element.isConnected &&
    !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible"
  );
}

// Fullscreen readers use z-45; shared dialogs/popovers use z-50. A later
// mounted reader must not outrank an existing overlay in the higher band.
function popupLayer(element: HTMLElement) {
  let layer = 0;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const zIndex = Number.parseInt(getComputedStyle(current).zIndex, 10);
    if (!Number.isNaN(zIndex)) layer = zIndex;
  }
  return layer;
}

function firstInput(scope: ParentNode) {
  return Array.from(scope.querySelectorAll<HTMLElement>(inputSelector)).find(
    (input) => visible(input) && !input.closest(nativeTabSelector),
  );
}

/** Plain Tab is an explicit writing intent, not sequential control navigation. */
export function useTabInputFocus() {
  useEffect(() => {
    // DOM focus ownership is transient and window-local. Remember the last chat, not
    // its input: closing a side chat or changing the active split invalidates it.
    let lastChat: HTMLElement | null = null;
    const rememberChat = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(popupSelector)) return;
      const chat = target.closest<HTMLElement>('[data-slot="chat"]');
      if (chat) lastChat = chat;
    };
    const focusInput = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.defaultPrevented
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(`${nativeTabSelector}, [data-slot="hotkey-recorder"]`)
      )
        return;

      event.preventDefault();
      // Claim the shortcut before local focus traps and suggestion completion.
      event.stopPropagation();
      // Within each overlay band, shared primitives portal in opening order.
      // Ignore hidden/exiting surfaces; prefer the inner surface to its backdrop.
      const popup = Array.from(document.querySelectorAll<HTMLElement>(popupSelector))
        .filter(visible)
        .sort((left, right) => popupLayer(left) - popupLayer(right))
        .at(-1);
      const active = document.activeElement;
      if (popup) {
        if (
          active instanceof HTMLElement &&
          popup.contains(active) &&
          active.matches(inputSelector)
        )
          return;
        const input = firstInput(popup);
        if (input) input.focus({ preventScroll: true });
        else if (!popup.contains(active)) {
          // No writing field: retain popup ownership instead of leaking to the
          // underlying composer. Existing arrow/Escape/Shift+Tab behavior remains.
          const control = Array.from(
            popup.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex]"),
          ).find(visible);
          if (control) control.focus({ preventScroll: true });
          else {
            popup.tabIndex = -1;
            popup.focus({ preventScroll: true });
          }
        }
        return;
      }
      // An explicit writing focus is never moved or its selection changed.
      if (
        active instanceof HTMLElement &&
        active.matches(inputSelector) &&
        visible(active) &&
        active.closest('[data-slot="chat"]')?.matches(chatSelector) !== false
      )
        return;
      const chats = Array.from(document.querySelectorAll<HTMLElement>(chatSelector)).filter(
        visible,
      );
      const chat = lastChat && chats.includes(lastChat) ? lastChat : chats[0];
      if (chat) {
        const input = firstInput(chat.querySelector('[data-slot="composer-input"]') ?? chat);
        input?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", rememberChat, true);
    window.addEventListener("focusin", rememberChat, true);
    window.addEventListener("keydown", focusInput, true);
    return () => {
      window.removeEventListener("pointerdown", rememberChat, true);
      window.removeEventListener("focusin", rememberChat, true);
      window.removeEventListener("keydown", focusInput, true);
    };
  }, []);
}
