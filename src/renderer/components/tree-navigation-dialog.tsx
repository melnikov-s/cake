import { type FormEvent } from "react";
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
import { Textarea } from "./ui/textarea";
import type { CommandPaneStore, TreeNavigationSummaryMode } from "../stores/CommandPaneStore";

const summaryChoices: ReadonlyArray<{
  value: TreeNavigationSummaryMode;
  title: string;
  description: string;
}> = [
  {
    value: "none",
    title: "No summary",
    description: "Move to this message without carrying over the branch you are leaving.",
  },
  {
    value: "summary",
    title: "Summarize the current branch",
    description: "Ask Pi to preserve the important context from the branch you are leaving.",
  },
  {
    value: "custom",
    title: "Summarize with custom focus",
    description: "Tell Pi what the branch summary should emphasize.",
  },
];

export const TreeNavigationDialog = observer(function TreeNavigationDialog({
  store,
}: {
  store: CommandPaneStore;
}) {
  const prompt = store.navigationPrompt;
  if (!prompt) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void store.confirmNavigation();
  };

  return (
    <FullscreenSurface
      eyebrow="Session tree"
      mode="dialog"
      title="Continue from this message"
      onClose={() => store.cancelNavigation()}
    >
      <Confirmation
        state="requested"
        aria-labelledby="tree-navigation-title"
        aria-describedby="tree-navigation-description"
      >
        <ConfirmationRequest>
          <form onSubmit={submit}>
            <ConfirmationTitle id="tree-navigation-title">
              Continue from this message
            </ConfirmationTitle>
            <ConfirmationDescription id="tree-navigation-description">
              Choose whether Pi should summarize the branch you are leaving before moving the
              session to this point.
            </ConfirmationDescription>
            <div className="mt-4 grid gap-2" role="group" aria-label="Branch summary">
              {summaryChoices.map((choice) => (
                <ActionCard
                  key={choice.value}
                  autoFocus={choice.value === "none"}
                  aria-pressed={prompt.summaryMode === choice.value}
                  aria-label={choice.title}
                  title={choice.title}
                  description={choice.description}
                  descriptionClassName="whitespace-normal leading-relaxed"
                  className={
                    prompt.summaryMode === choice.value ? "border-ring bg-accent/40" : undefined
                  }
                  onClick={() => store.selectNavigationSummary(choice.value)}
                />
              ))}
            </div>
            {prompt.summaryMode === "custom" && (
              <label className="mt-3 block text-sm font-medium">
                Summary focus
                <Textarea
                  className="mt-1.5 min-h-24 resize-y"
                  value={prompt.customInstructions}
                  onChange={(event) => store.setNavigationInstructions(event.target.value)}
                  placeholder="Focus on decisions, unfinished work, and important files…"
                  maxLength={16_384}
                  required
                  autoFocus
                />
              </label>
            )}
            <ConfirmationActions>
              <ConfirmationAction
                type="button"
                variant="outline"
                onClick={() => store.cancelNavigation()}
              >
                Cancel
              </ConfirmationAction>
              <ConfirmationAction type="submit">Continue here</ConfirmationAction>
            </ConfirmationActions>
          </form>
        </ConfirmationRequest>
      </Confirmation>
    </FullscreenSurface>
  );
});
