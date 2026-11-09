import { useEffect, useLayoutEffect, useId, useRef, useState, type RefObject } from "react";
import { useOptionalStore } from "r-state-tree/react";
import { DictationStore, type DictationSubmission } from "../stores/DictationStore";
import { Button } from "./ui/button";
import { annotationDismissalEvent } from "../lib/annotation-dismissal";
import { DialogBackdrop, DialogContent, DialogFooter, DialogTitle } from "./ui/dialog";

/** Keep the editor mounted: recognition can still write its final result while we ask. */
export function useAnnotationDismissal({
  surface,
  input,
  enabled = true,
  changed = true,
  onDismiss,
  onSubmit,
}: {
  surface: RefObject<HTMLDivElement | null>;
  input: RefObject<HTMLTextAreaElement | null>;
  enabled?: boolean;
  changed?: boolean;
  onDismiss(): void;
  onSubmit(value: string): void | boolean;
}) {
  const owner = useId();
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const voice = useOptionalStore(DictationStore);
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmation = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const ticket = useRef<DictationSubmission | undefined>(undefined);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const selection = useRef({ start: 0, end: 0 });
  const state = useRef({ enabled, changed, onDismiss, onSubmit, confirming });
  state.current = { enabled, changed, onDismiss, onSubmit, confirming };

  useLayoutEffect(() => {
    if (!enabled) return;
    // Hidden Electron surfaces need the next frame; never steal focus back from confirmation.
    const frame = requestAnimationFrame(() => {
      if (!state.current.confirming) input.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, input]);

  function hasDraft() {
    return (
      state.current.enabled &&
      ((state.current.changed && !!input.current?.value.trim()) ||
        (!!voice?.activeTargetId &&
          voice.hasSpeechToFinish(voice.activeTargetId) &&
          input.current?.dataset.dictationSubmissionOwner === owner))
    );
  }
  function rememberSelection() {
    if (input.current)
      selection.current = {
        start: input.current.selectionStart,
        end: input.current.selectionEnd,
      };
  }
  function keepEditing() {
    if (pending.current) return;
    setConfirming(false);
    setFailed(false);
    voice?.completeSubmission(ticket.current, false);
    ticket.current = undefined;
    input.current?.focus({ preventScroll: true });
    input.current?.setSelectionRange(selection.current.start, selection.current.end);
  }
  function finalize(next: () => void) {
    if (pending.current) return;
    if (!voice?.enabled || ticket.current?.ready) {
      next();
      return;
    }
    setFinishing(true);
    pending.current = voice
      .prepareSubmission(owner)
      .then((result) => {
        if (!mounted.current) return;
        ticket.current = result;
        if (result && !result.ready) setFailed(true);
        else next();
      })
      .catch(() => {
        // Submission/recognition failure must never turn into an implicit discard.
        if (mounted.current) setFailed(true);
      })
      .finally(() => {
        pending.current = undefined;
        if (mounted.current) setFinishing(false);
      });
  }
  function dismiss() {
    if (pending.current) return;
    if (!hasDraft()) {
      state.current.onDismiss();
      return;
    }
    rememberSelection();
    state.current.confirming = true;
    setConfirming(true);
    finalize(() => {});
  }
  function submit() {
    finalize(() => {
      // Read after recognition/cleanup, never from the render that initiated Submit.
      if (state.current.onSubmit(input.current?.value ?? "") === false) return;
      voice?.completeSubmission(ticket.current, true);
      ticket.current = undefined;
      setConfirming(false);
    });
  }

  // Capture phase is essential: a tool/navigation click must not unmount the draft first.
  const actions = useRef({ dismiss, keepEditing, hasDraft });
  actions.current = { dismiss, keepEditing, hasDraft };
  useEffect(() => {
    const block = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const outside = (event: Event) => {
      if (!state.current.enabled) return;
      const target = event.target;
      if (
        target instanceof Node &&
        (confirmation.current?.contains(target) ||
          (!state.current.confirming && surface.current?.contains(target)))
      )
        return;
      if (actions.current.hasDraft() || state.current.confirming) {
        block(event);
        if (!state.current.confirming) actions.current.dismiss();
      } else if (event.type === "pointerdown") state.current.onDismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!state.current.enabled || event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        block(event);
        if (state.current.confirming) actions.current.keepEditing();
        else actions.current.dismiss();
      } else if (event.key === "Tab" && (actions.current.hasDraft() || state.current.confirming)) {
        const root = state.current.confirming ? confirmation.current : surface.current;
        const controls = Array.from(
          root?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ) ?? [],
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (!controls.length) block(event);
        else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === root)
        ) {
          block(event);
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === root)
        ) {
          block(event);
          first?.focus();
        }
      } else if (
        (event.metaKey || event.ctrlKey) &&
        ["w", "r", "[", "]"].includes(event.key.toLowerCase()) &&
        (actions.current.hasDraft() || state.current.confirming)
      ) {
        block(event);
        if (!state.current.confirming) actions.current.dismiss();
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!actions.current.hasDraft() && !state.current.confirming) return;
      event.preventDefault();
      event.returnValue = "";
      if (!state.current.confirming) actions.current.dismiss();
    };
    const request = (event: Event) => {
      if (!actions.current.hasDraft() && !state.current.confirming) return;
      event.preventDefault();
      if (!state.current.confirming) actions.current.dismiss();
    };
    window.addEventListener(annotationDismissalEvent, request);
    const events = ["pointerdown", "pointerup", "click", "contextmenu"];
    events.forEach((name) => document.addEventListener(name, outside, true));
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      events.forEach((name) => document.removeEventListener(name, outside, true));
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener(annotationDismissalEvent, request);
    };
  }, [input, owner, surface, voice]);
  useEffect(() => {
    if (confirming)
      (finishing ? confirmation.current : keepButton.current)?.focus({ preventScroll: true });
  }, [confirming, finishing]);

  return {
    owner,
    dismiss,
    submit,
    confirmation: confirming && (
      <DialogBackdrop
        role="alertdialog"
        aria-labelledby={`${owner}-title`}
        className="z-[100]"
        onClose={keepEditing}
      >
        <DialogContent ref={confirmation} tabIndex={-1} className="max-w-sm">
          <DialogTitle id={`${owner}-title`}>Unsubmitted annotation</DialogTitle>
          <p className="mt-3 text-xs text-muted-foreground" role="status">
            {finishing
              ? "Finishing dictation…"
              : failed
                ? "Dictation could not finish. Keep editing to retry, or discard the draft."
                : "Submit this annotation, discard it, or keep editing."}
          </p>
          <DialogFooter className="flex-wrap">
            <Button
              ref={keepButton}
              size="sm"
              variant="outline"
              disabled={finishing}
              onClick={keepEditing}
            >
              Keep editing
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={finishing}
              onClick={() => {
                voice?.completeSubmission(ticket.current, true);
                if (voice?.activeTargetId) voice.stop(voice.activeTargetId);
                ticket.current = undefined;
                setConfirming(false);
                state.current.onDismiss();
              }}
            >
              Discard
            </Button>
            <Button size="sm" disabled={finishing || failed} onClick={submit}>
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogBackdrop>
    ),
  };
}
