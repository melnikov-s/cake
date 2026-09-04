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
import { ActionCard } from "./ui/action-card";
import { DialogBackdrop } from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import type {
  SessionContinuationDestination,
  SessionContinuationStore,
} from "../stores/SessionContinuationStore";

const destinations: ReadonlyArray<{
  value: SessionContinuationDestination;
  title: string;
  description: string;
}> = [
  {
    value: "existing",
    title: "Use the current working directory",
    description: "Continue in the same checkout as the parent conversation.",
  },
  {
    value: "branch-worktree",
    title: "Branch off the current worktree",
    description: "Create a child worktree from the current worktree's committed HEAD.",
  },
  {
    value: "project-root",
    title: "Use the project root (no worktree)",
    description: "Continue in the project's main checkout without a managed worktree.",
  },
  {
    value: "new-worktree",
    title: "Create a new worktree",
    description: "Create an isolated worktree from the project's default branch.",
  },
];

export const SessionContinuationDialog = observer(function SessionContinuationDialog({
  store,
}: {
  store: SessionContinuationStore;
}) {
  const prompt = store.prompt;
  if (!prompt) return null;

  const isFork = prompt.kind === "fork";
  const createsWorktree =
    prompt.destination === "branch-worktree" || prompt.destination === "new-worktree";
  const title = isFork ? "Fork this conversation" : "Hand off this conversation";
  const action = isFork ? "Fork conversation" : "Hand off conversation";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void store.confirmPrompt();
  };

  return (
    <DialogBackdrop onClose={() => store.cancelPrompt()}>
      <Confirmation
        state="requested"
        role="dialog"
        aria-labelledby="session-continuation-title"
        aria-describedby="session-continuation-description"
      >
        <ConfirmationRequest>
          <form onSubmit={submit}>
            <ConfirmationTitle id="session-continuation-title">{title}</ConfirmationTitle>
            <ConfirmationDescription id="session-continuation-description">
              Choose where the new conversation should make its changes.
            </ConfirmationDescription>
            <div className="mt-4 grid gap-2" role="group" aria-label="Working directory">
              {destinations.map((destination) => {
                const unavailable =
                  destination.value === "branch-worktree" && !prompt.canBranchFromCurrentWorktree;
                return (
                  <ActionCard
                    key={destination.value}
                    aria-pressed={prompt.destination === destination.value}
                    aria-label={destination.title}
                    title={destination.title}
                    description={
                      unavailable
                        ? "The current working directory is not a managed worktree."
                        : destination.description
                    }
                    disabled={unavailable}
                    className={
                      prompt.destination === destination.value
                        ? "border-ring bg-accent/40"
                        : undefined
                    }
                    onClick={() => store.selectDestination(destination.value)}
                  />
                );
              })}
            </div>
            {createsWorktree && (
              <label className="mt-3 block text-sm font-medium">
                Worktree name
                <Input
                  className="mt-1.5"
                  size="lg"
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
            <div className="mt-4 flex items-center justify-between gap-4">
              <span id="resolve-parent-label" className="text-sm">
                Resolve the parent conversation after {isFork ? "forking" : "handoff"}
              </span>
              <Switch
                checked={prompt.resolveParent}
                onCheckedChange={(checked) => store.setResolveParent(checked)}
                aria-labelledby="resolve-parent-label"
              />
            </div>
            <ConfirmationActions>
              <ConfirmationAction
                type="button"
                variant="outline"
                onClick={() => store.cancelPrompt()}
              >
                Cancel
              </ConfirmationAction>
              <ConfirmationAction type="submit">{action}</ConfirmationAction>
            </ConfirmationActions>
          </form>
        </ConfirmationRequest>
      </Confirmation>
    </DialogBackdrop>
  );
});
