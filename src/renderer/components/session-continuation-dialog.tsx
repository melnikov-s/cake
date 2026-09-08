import { useEffect, useRef, type FormEvent } from "react";
import { observer } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";
import { FullscreenSurface } from "./fullscreen-surface";
import { ActionCard } from "./ui/action-card";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import type {
  SessionContinuationDestination,
  SessionContinuationPrompt,
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

function destinationIsVisible(
  prompt: SessionContinuationPrompt,
  destination: SessionContinuationDestination,
) {
  return destination !== "project-root" || prompt.workspacePath !== prompt.projectPath;
}

function destinationIsSelectable(
  prompt: SessionContinuationPrompt,
  destination: SessionContinuationDestination,
) {
  return (
    destinationIsVisible(prompt, destination) &&
    (destination !== "branch-worktree" || prompt.canBranchFromCurrentWorktree)
  );
}

export const SessionContinuationDialog = observer(function SessionContinuationDialog({
  store,
}: {
  store: SessionContinuationStore;
}) {
  const destinationRefs = useRef(
    new Map<SessionContinuationDestination, HTMLButtonElement>(),
  ).current;
  const worktreeNameRef = useRef<HTMLInputElement>(null);
  const prompt = store.prompt;

  useEffect(() => {
    if (!prompt) return;
    const selectableDestinations = destinations.filter((destination) =>
      destinationIsSelectable(prompt, destination.value),
    );
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Enter") {
        if (![...destinationRefs.values()].some((element) => element === document.activeElement)) {
          return;
        }
        event.preventDefault();
        void store.confirmPrompt();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const currentIndex = selectableDestinations.findIndex(
        (destination) => destination.value === prompt.destination,
      );
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (currentIndex + direction + selectableDestinations.length) % selectableDestinations.length;
      const nextDestination = selectableDestinations[nextIndex]?.value;
      if (!nextDestination) return;
      store.selectDestination(nextDestination);
      requestAnimationFrame(() => {
        if (nextDestination === "branch-worktree" || nextDestination === "new-worktree") {
          worktreeNameRef.current?.focus();
        } else {
          destinationRefs.get(nextDestination)?.focus();
        }
      });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [destinationRefs, prompt, store]);

  if (!prompt) return null;

  const isFork = prompt.kind === "fork";
  const createsWorktree =
    prompt.destination === "branch-worktree" || prompt.destination === "new-worktree";
  const title = isFork ? "Fork this conversation" : "Hand off this conversation";
  const action = isFork ? "Fork conversation" : "Hand off conversation";
  const visibleDestinations = destinations.filter((destination) =>
    destinationIsVisible(prompt, destination.value),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void store.confirmPrompt();
  };

  return (
    <FullscreenSurface
      eyebrow="Conversation continuation"
      mode="dialog"
      title={title}
      onClose={() => store.cancelPrompt()}
    >
      <Confirmation
        state="requested"
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
              {visibleDestinations.map((destination) => {
                const unavailable =
                  destination.value === "branch-worktree" && !prompt.canBranchFromCurrentWorktree;
                return (
                  <ActionCard
                    ref={(element) => {
                      if (element) destinationRefs.set(destination.value, element);
                      else destinationRefs.delete(destination.value);
                    }}
                    key={destination.value}
                    autoFocus={prompt.destination === destination.value}
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
                  ref={worktreeNameRef}
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
    </FullscreenSurface>
  );
});
