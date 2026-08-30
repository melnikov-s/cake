import type { FormEvent } from "react";
import { observer } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";
import { DialogBackdrop } from "./ui/dialog";
import type { SessionContinuationStore } from "../stores/SessionContinuationStore";

export const ForkSessionDialog = observer(function ForkSessionDialog({
  store,
}: {
  store: SessionContinuationStore;
}) {
  const prompt = store.prompt;
  if (!prompt) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void store.confirmPrompt();
  };

  return (
    <DialogBackdrop onClose={() => store.cancelPrompt()}>
      <Confirmation
        state="requested"
        role="dialog"
        aria-labelledby="fork-session-title"
        aria-describedby="fork-session-description"
      >
        <ConfirmationRequest>
          <form onSubmit={submit}>
            <ConfirmationTitle id="fork-session-title">Fork this conversation</ConfirmationTitle>
            <ConfirmationDescription id="fork-session-description">
              Choose where the forked conversation should make its changes.
            </ConfirmationDescription>
            <fieldset className="mt-4 grid gap-2">
              <legend className="sr-only">Fork destination</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-checked:border-ring has-checked:bg-accent/40">
                <input
                  className="mt-1 accent-primary"
                  type="radio"
                  name="fork-destination"
                  value="existing"
                  checked={prompt.destination === "existing"}
                  onChange={() => store.selectDestination("existing")}
                />
                <span>
                  <span className="block text-sm font-medium">Use the existing worktree</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Continue in the same checkout as the parent.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-checked:border-ring has-checked:bg-accent/40">
                <input
                  className="mt-1 accent-primary"
                  type="radio"
                  name="fork-destination"
                  value="new-worktree"
                  checked={prompt.destination === "new-worktree"}
                  onChange={() => store.selectDestination("new-worktree")}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Create a new worktree</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Isolate the fork in a new Cake-managed checkout.
                  </span>
                </span>
              </label>
            </fieldset>
            {prompt.destination === "new-worktree" && (
              <label className="mt-3 block text-sm font-medium">
                Worktree name
                <input
                  className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  value={prompt.worktreeName}
                  onChange={(event) => store.setWorktreeName(event.target.value)}
                  pattern="[a-z0-9][a-z0-9-]{0,62}"
                  maxLength={63}
                  required
                  autoFocus
                  aria-describedby="worktree-name-help"
                />
                <span
                  id="worktree-name-help"
                  className="mt-1 block text-xs font-normal text-muted-foreground"
                >
                  Lowercase letters, numbers, and hyphens.
                </span>
              </label>
            )}
            {prompt.destination === "new-worktree" && (
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
                <input
                  className="accent-primary"
                  type="checkbox"
                  checked={prompt.resolveParent}
                  onChange={(event) => store.setResolveParent(event.target.checked)}
                />
                Resolve the parent conversation after forking
              </label>
            )}
            <ConfirmationActions>
              <ConfirmationAction
                type="button"
                variant="outline"
                onClick={() => store.cancelPrompt()}
              >
                Cancel
              </ConfirmationAction>
              <ConfirmationAction type="submit">Fork conversation</ConfirmationAction>
            </ConfirmationActions>
          </form>
        </ConfirmationRequest>
      </Confirmation>
    </DialogBackdrop>
  );
});
