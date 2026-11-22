import { useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { ComposerInputElement } from "../lib/composer-input-element";
import { applyInputEdit, inputSelection } from "../lib/input-edit";
import type { InputSelection } from "../lib/input-edit-history";
import { isVisibleForKeyboard, keyboardPopupSelector } from "../lib/keyboard-focus";

const chatSelector = '[data-slot="chat"][data-composer-focus-enabled="true"]';
const modifiers = new Set([
  "Shift",
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "CapsLock",
  "Fn",
  "FnLock",
  "NumLock",
  "ScrollLock",
]);
const nativeControls =
  "input, textarea, select, iframe, webview, .xterm, .monaco-editor, .cm-editor";
const popupIsOpen = () =>
  Array.from(document.querySelectorAll<HTMLElement>(keyboardPopupSelector)).some(
    isVisibleForKeyboard,
  );

export interface ChatPickerPreview {
  activate(selection: InputSelection): void;
  dismiss(): void;
}

/** A symbol previews a picker, but only the next unmodified Tab commits to it. */
export function useChatPickerShortcuts(
  inputRef: RefObject<ComposerInputElement | null>,
  enabled: boolean,
  openPreview: (
    symbol: "#" | "$",
    input: ComposerInputElement,
    origin: HTMLElement,
  ) => ChatPickerPreview | undefined,
) {
  const open = useRef(openPreview);
  open.current = openPreview;
  useLayoutEffect(() => {
    if (!enabled) return;
    let pending:
      | (ChatPickerPreview & {
          input: ComposerInputElement;
          origin: HTMLElement;
          symbol: "#" | "$";
          before?: InputSelection;
        })
      | undefined;
    const dismiss = () => {
      const preview = pending;
      pending = undefined;
      preview?.dismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (modifiers.has(event.key)) return;
      const input = inputRef.current;
      const target = event.target;
      const composing = event.isComposing || event.keyCode === 229;
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (pending) {
        const preview = pending;
        pending = undefined;
        const canClaim =
          !event.defaultPrevented &&
          !composing &&
          !modified &&
          input === preview.input &&
          document.activeElement === preview.origin &&
          !popupIsOpen();
        if (canClaim && event.key === "Tab" && !event.shiftKey && !event.repeat) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const current = inputSelection(input);
          const before = preview.before;
          // The browser performed the literal edit. Reverse only that exact edit,
          // including any replaced selection. Never guess at a trigger's position.
          const inserted =
            before &&
            current.value ===
              before.value.slice(0, before.start) +
                preview.symbol +
                before.value.slice(before.end) &&
            current.start === before.start + 1 &&
            current.end === current.start;
          flushSync(() => {
            if (inserted) applyInputEdit(input, before);
            preview.activate(inserted ? before : current);
          });
        } else {
          if (canClaim && event.key === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          preview.dismiss();
        }
        return;
      }
      if (
        (event.key !== "#" && event.key !== "$") ||
        event.repeat ||
        event.defaultPrevented ||
        composing ||
        modified ||
        !input ||
        input.disabled ||
        input.readOnly ||
        !(target instanceof HTMLElement) ||
        !isVisibleForKeyboard(input)
      )
        return;
      const chat = input.closest(chatSelector);
      const workspace = chat?.closest('[data-slot="workspace"]');
      if (!workspace || target !== document.activeElement) return;
      if (target !== input) {
        if (target.isContentEditable || target.closest(nativeControls)) return;
        const targetChat = target.closest('[data-slot="chat"]');
        if (
          targetChat
            ? targetChat !== chat
            : workspace.hasAttribute("data-tool-workspace") ||
              (target !== document.body && !workspace.closest("main")?.contains(target)) ||
              Array.from(workspace.querySelectorAll<HTMLElement>(chatSelector)).find(
                isVisibleForKeyboard,
              ) !== chat
        )
          return;
      }
      if ((target === input && input.getAttribute("aria-expanded") === "true") || popupIsOpen())
        return;
      const before = target === input ? inputSelection(input) : undefined;
      const preview = open.current(event.key, input, target);
      if (preview) pending = { ...preview, input, origin: target, symbol: event.key, before };
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("focusin", dismiss, true);
    window.addEventListener("compositionstart", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("focusin", dismiss, true);
      window.removeEventListener("compositionstart", dismiss, true);
      window.removeEventListener("blur", dismiss);
      dismiss();
    };
  }, [enabled, inputRef]);
}
