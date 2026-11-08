import { useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { ComposerInputElement } from "../lib/composer-input-element";
import { InputEditHistory, type InputSelection } from "../lib/input-edit-history";
import { applyInputEdit, inputEditDetails, inputSelection } from "../lib/input-edit";

/** Field-local undo history over native editing events. Controlled writes/token DOM swaps
 * invalidate Chromium's history, so ordinary and application edits must share one stack. */
export function useInputEditHistory(
  input: RefObject<ComposerInputElement | null>,
  renderedValue: string,
  authoritativeValue: string,
  boundary: number,
) {
  const history = useRef(new InputEditHistory({ value: authoritativeValue, start: 0, end: 0 }));
  const previousBoundary = useRef(boundary);
  const replaying = useRef(false);
  const pending = useRef<InputSelection | undefined>(undefined);
  const composition = useRef<symbol | undefined>(undefined);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const state = history.current;
    if (previousBoundary.current !== boundary) {
      previousBoundary.current = boundary;
      state.reset({ value: authoritativeValue, start: 0, end: 0 });
      pending.current = undefined;
      composition.current = undefined;
    }
    if (renderedValue === authoritativeValue && state.current.value !== renderedValue) {
      state.record(state.current, inputSelection(element), "replacement", performance.now());
    }
    const restore = (redo: boolean) => {
      if (element.disabled || element.readOnly) return;
      const next = redo ? state.redo() : state.undo();
      pending.current = undefined;
      if (!next) return;
      replaying.current = true;
      try {
        flushSync(() => applyInputEdit(element, next));
      } finally {
        replaying.current = false;
      }
    };
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        restore(event.inputType === "historyRedo");
        return;
      }
      pending.current = inputSelection(element);
    };
    const changed = (event: Event) => {
      if (replaying.current) return;
      const next = inputSelection(element);
      const kind = event instanceof InputEvent ? event.inputType : "replacement";
      const edit = inputEditDetails(event);
      state.record(
        edit?.before ?? pending.current ?? state.current,
        next,
        kind,
        performance.now(),
        edit?.group ?? composition.current,
      );
      pending.current = undefined;
    };
    const selected = () => state.select(inputSelection(element));
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const key = event.key.toLowerCase();
      const undo = (event.metaKey || event.ctrlKey) && key === "z";
      const redo = event.ctrlKey && !event.metaKey && key === "y";
      if (!undo && !redo) return;
      event.preventDefault();
      event.stopPropagation();
      restore(redo || event.shiftKey);
    };
    const compositionStart = () => {
      composition.current = Symbol("composition");
    };
    const compositionEnd = () => {
      composition.current = undefined;
    };
    element.addEventListener("beforeinput", beforeInput);
    element.addEventListener("input", changed, true);
    element.addEventListener("select", selected);
    element.addEventListener("keyup", selected);
    element.addEventListener("mouseup", selected);
    element.addEventListener("keydown", keyDown);
    element.addEventListener("compositionstart", compositionStart);
    element.addEventListener("compositionend", compositionEnd);
    return () => {
      element.removeEventListener("beforeinput", beforeInput);
      element.removeEventListener("input", changed, true);
      element.removeEventListener("select", selected);
      element.removeEventListener("keyup", selected);
      element.removeEventListener("mouseup", selected);
      element.removeEventListener("keydown", keyDown);
      element.removeEventListener("compositionstart", compositionStart);
      element.removeEventListener("compositionend", compositionEnd);
    };
  });
}
