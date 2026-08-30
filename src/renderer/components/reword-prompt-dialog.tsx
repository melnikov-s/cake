import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { ComposerInput } from "@/components/ai-elements/composer";
import { DialogBackdrop } from "@/components/ui/dialog";

export function RewordPromptDialog({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel(): void;
  onSubmit(prompt: string): void;
}) {
  const [prompt, setPrompt] = useState("");
  const titleId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim()) onSubmit(prompt.trim());
  };

  return (
    <DialogBackdrop
      aria-labelledby={titleId}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <Confirmation
        className="w-full max-w-lg"
        state="requested"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <ConfirmationRequest>
          <form onSubmit={submit}>
            <ConfirmationTitle id={titleId}>Reword with Prompt</ConfirmationTitle>
            <ConfirmationDescription>
              Tell the utility model how you want the selected text rewritten.
            </ConfirmationDescription>
            <ComposerInput
              ref={inputRef}
              className="mt-4 min-h-24 rounded-lg border border-border bg-background px-3"
              aria-label="Reword prompt"
              placeholder="For example: Make this concise and preserve my tone"
              value={prompt}
              disabled={busy}
              onChange={(event) => setPrompt(event.currentTarget.value)}
            />
            <ConfirmationActions>
              <ConfirmationAction
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </ConfirmationAction>
              <ConfirmationAction type="submit" disabled={busy || !prompt.trim()}>
                {busy ? "Rewording…" : "Reword"}
              </ConfirmationAction>
            </ConfirmationActions>
          </form>
        </ConfirmationRequest>
      </Confirmation>
    </DialogBackdrop>
  );
}
