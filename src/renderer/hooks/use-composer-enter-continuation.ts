import { useLayoutEffect, type RefObject } from "react";
import type { ComposerFocusHandle } from "../components/slash-command-combobox";
import type { ChatStore } from "../stores/ChatStore";

/** Window-wide cancellation, but Enter belongs only to the originating composer. */
export function useComposerEnterContinuation(
  store: ChatStore,
  enabled: boolean,
  input: RefObject<HTMLTextAreaElement | null>,
  focus: RefObject<ComposerFocusHandle | null>,
) {
  useLayoutEffect(() => {
    store.cancelEnterContinuation();
    if (!enabled) return;
    const cancel = () => store.cancelEnterContinuation();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!store.hasEnterContinuation) return;
      const anchor = focus.current?.parkingAnchor();
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        !focus.current?.shouldParkFocus() ||
        (event.target !== anchor && event.target !== input.current)
      ) {
        cancel();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // A held key is not a second deliberate press.
      if (!event.repeat) store.continueSentMessage();
    };
    const onFocus = (event: FocusEvent) => {
      if (store.hasEnterContinuation && event.target !== focus.current?.parkingAnchor()) cancel();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (store.hasEnterContinuation && event.relatedTarget !== focus.current?.parkingAnchor())
        cancel();
    };
    const onSelection = () => {
      if (!store.hasEnterContinuation) return;
      const field = input.current;
      if (
        window.getSelection()?.isCollapsed === false ||
        (document.activeElement === field && field?.selectionStart !== field?.selectionEnd)
      )
        cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("wheel", cancel, true);
    window.addEventListener("focusin", onFocus, true);
    window.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      cancel();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [store, enabled, input, focus]);
}
