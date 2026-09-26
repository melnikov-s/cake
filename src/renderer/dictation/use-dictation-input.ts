import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useOptionalStore } from "r-state-tree/react";
import { DictationStore, type DictationTarget } from "../stores/DictationStore";

/** DOM-only adapter: the Store owns capture, focus generations, and inference policy. */
export function useDictationInput(enabled: boolean, input: RefObject<HTMLTextAreaElement | null>) {
  const store = useOptionalStore(DictationStore);
  const id = useId();
  const inserting = useRef(false);
  const replaying = useRef(false);
  const insertion = useRef({ before: "", after: "", value: "", caret: -1 });
  const target = useRef<DictationTarget>({
    id,
    begin() {
      const element = input.current;
      if (!element) return;
      insertion.current = {
        before: element.value.slice(0, element.selectionStart),
        after: element.value.slice(element.selectionEnd),
        value: element.value,
        caret: element.selectionEnd,
      };
    },
    replace(text) {
      const element = input.current;
      if (!element || document.activeElement !== element || element.disabled || element.readOnly)
        return;
      const range = insertion.current;
      if (element.value !== range.value) {
        store?.restart(id);
        return;
      }
      if (!text.trim()) return;
      const prefix = range.before && !/\s$/.test(range.before) ? " " : "";
      const suffix = range.after && !/^\s/.test(range.after) ? " " : "";
      const speech = prefix + text.trim() + suffix;
      const value = range.before + speech + range.after;
      const caret = range.before.length + speech.length;
      inserting.current = true;
      try {
        // Invoke the native setter so React's value tracker sees the input event.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          element,
          value,
        );
        element.setSelectionRange(caret, caret);
        insertion.current = { ...range, value, caret };
        flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
      } finally {
        inserting.current = false;
      }
    },
  });

  useEffect(() => {
    if (!enabled || !store) return;
    const field = target.current;
    const focused = () => {
      const element = input.current;
      if (
        document.hasFocus() &&
        document.activeElement === element &&
        !element?.disabled &&
        !element?.readOnly
      )
        store.focus(field);
    };
    const blur = () => store.blur(id);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focused);
    focused();
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focused);
      store.blur(id);
    };
  }, [enabled, id, input, store]);

  return {
    id,
    store: enabled ? store : null,
    onFocus() {
      if (enabled && !input.current?.readOnly && !input.current?.disabled)
        store?.focus(target.current);
    },
    onBlur() {
      if (enabled) store?.blur(id);
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
        (element.selectionStart !== insertion.current.caret ||
          element.selectionEnd !== insertion.current.caret)
      )
        store?.restart(id);
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, submitHandled: boolean): boolean {
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
        event.currentTarget.getAttribute("aria-expanded") === "true"
      )
        return false;
      event.preventDefault();
      event.stopPropagation();
      const element = event.currentTarget;
      void store.finish(id).then((finished) => {
        if (!finished || !element.isConnected || document.activeElement !== element) return;
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
