import { useLayoutEffect, useId, useRef, type KeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useOptionalStore } from "r-state-tree/react";
import type { ComposerInputElement } from "../lib/composer-input-element";
import { DictationStore, type DictationTarget } from "../stores/DictationStore";

/** DOM-only adapter: the Store owns capture, focus generations, and inference policy. */
export function useDictationInput(
  enabled: boolean,
  input: RefObject<ComposerInputElement | null>,
  submit?: () => void | Promise<void>,
) {
  const store = useOptionalStore(DictationStore);
  const id = useId();
  // Targets outlive renders. Revoke their DOM access immediately when the field opts out,
  // including results already queued before the capture generation is cancelled.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const inserting = useRef(false);
  const replaying = useRef(false);
  const insertion = useRef({
    before: "",
    after: "",
    value: "",
    original: "",
    selectionStart: -1,
    selectionEnd: -1,
    start: -1,
    caret: -1,
  });
  const target = useRef<DictationTarget>({
    id,
    submissionOwner: () => input.current?.dataset.dictationSubmissionOwner,
    submitted() {
      const element = input.current;
      if (element && document.activeElement === element) {
        // Transfer directly: an intermediate body focus would cancel rapid-Enter continuation.
        if (element.parentElement?.hasAttribute("tabindex")) element.parentElement.focus();
        else element.blur();
      }
    },
    get submit() {
      if (!submitRef.current) return undefined;
      return () => {
        const element = input.current;
        if (enabledRef.current && element?.isConnected && !element.disabled && !element.readOnly)
          return submitRef.current?.();
      };
    },
    begin() {
      const element = input.current;
      if (!enabledRef.current || !element) return;
      insertion.current = {
        before: element.value.slice(0, element.selectionStart),
        after: element.value.slice(element.selectionEnd),
        value: element.value,
        original: element.value,
        selectionStart: element.selectionStart,
        selectionEnd: element.selectionEnd,
        start: element.selectionStart,
        caret: element.selectionEnd,
      };
    },
    replace(text, discard = false) {
      const element = input.current;
      if (
        !enabledRef.current ||
        !element ||
        !element.isConnected ||
        element.disabled ||
        element.readOnly
      )
        return;
      const range = insertion.current;
      if (element.value !== range.value) {
        store?.restart(id);
        return;
      }
      const prefix = range.before && !/\s$/.test(range.before) ? " " : "";
      const suffix = range.after && !/^\s/.test(range.after) ? " " : "";
      const speech = text.trim() ? prefix + text.trim() + suffix : "";
      const value = discard ? range.original : range.before + speech + range.after;
      const start = discard ? range.selectionStart : range.before.length + speech.length;
      const caret = discard ? range.selectionEnd : start;
      inserting.current = true;
      try {
        // Invoke the native setter so React's value tracker sees the input event.
        if (element instanceof HTMLTextAreaElement)
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
            element,
            value,
          );
        else element.value = value;
        element.setSelectionRange(start, caret);
        insertion.current = { ...range, value, start, caret };
        flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
        // Programmatic value/selection updates do not reveal the tail like native typing.
        // Measure after React commits so content-sized inputs have their final height.
        element.scrollTop = element.scrollHeight;
      } finally {
        inserting.current = false;
      }
      return speech ? { value, start: range.before.length, end: caret } : undefined;
    },
  });

  // Cancel before paint, not in a passive effect: final/late results must not race the menu.
  useLayoutEffect(() => {
    if (!enabled || !store) return;
    const field = target.current;
    const focused = () => {
      const element = input.current;
      if (
        enabledRef.current &&
        document.hasFocus() &&
        document.activeElement === element &&
        !element?.disabled &&
        !element?.readOnly
      )
        store.focus(field, false);
    };
    // Focus loss never ends capture: leaving Cake, Browser Mode or VS Code keeps dictating here.
    // Escape reaches this listener only while Cake's page has keyboard focus.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !store.enabled ||
        store.muted ||
        store.activeTargetId !== id ||
        !store.capturing
      )
        return;
      event.preventDefault();
      store.stop(id);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("focus", focused);
    focused();
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("focus", focused);
      store.releaseTarget(id);
    };
  }, [enabled, id, input, store]);

  // A controlled draft reset (for example, after Send) is not a DOM input event.
  // Re-anchor now so the first subsequent recognition is not discarded as a stale edit.
  useLayoutEffect(() => {
    const element = input.current;
    if (enabled && !inserting.current && element && element.value !== insertion.current.value)
      store?.restart(id);
  });

  return {
    id,
    store: enabled ? store : null,
    onFocus() {
      if (enabled && !input.current?.readOnly && !input.current?.disabled)
        store?.focus(target.current);
    },
    onBlur(next: EventTarget | null) {
      const owner =
        next instanceof Element
          ? next.closest("[data-dictation-target]")?.getAttribute("data-dictation-target")
          : undefined;
      if (enabled) store?.blur(id, owner === id);
    },
    onChange() {
      if (enabled && !inserting.current) store?.restart(id);
    },
    onSelect() {
      const element = input.current;
      if (
        enabled &&
        !inserting.current &&
        element &&
        (element.selectionStart !== insertion.current.start ||
          element.selectionEnd !== insertion.current.caret)
      )
        store?.restart(id);
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>, submitHandled: boolean): boolean {
      if (
        enabled &&
        store?.enabled &&
        store.activeTargetId === id &&
        !store.muted &&
        store.capturing &&
        event.key === "Escape" &&
        event.currentTarget.getAttribute("aria-expanded") !== "true"
      ) {
        event.preventDefault();
        event.stopPropagation();
        store.stop(id);
        return true;
      }
      if (
        !enabled ||
        !store?.enabled ||
        (store.phase !== "listening" && store.phase !== "finishing") ||
        replaying.current ||
        !submitHandled ||
        event.key !== "Enter" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.nativeEvent.isComposing ||
        event.currentTarget.getAttribute("aria-expanded") === "true" ||
        // Empty Enter must not stop capture. Let the field handle attachment-only submits too.
        (store.phase === "listening" &&
          !input.current?.value.trim() &&
          !store.hasSpeechToFinish(id))
      )
        return false;
      event.preventDefault();
      event.stopPropagation();
      const element = event.currentTarget;
      void store.finish(id).then((finished) => {
        if (
          !enabledRef.current ||
          !finished ||
          !element.isConnected ||
          document.activeElement !== element
        )
          return;
        replaying.current = true;
        try {
          element.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              bubbles: true,
              cancelable: true,
            }),
          );
        } finally {
          replaying.current = false;
        }
        store.resume(id);
      });
      return true;
    },
  };
}
