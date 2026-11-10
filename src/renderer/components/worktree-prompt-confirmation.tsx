import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import type { WorktreeStore } from "../stores/WorktreeStore";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";

// Source-level UX default, not a new preference or provider policy.
const RUN_DELAY_MS = 10_000;

export const WorktreePromptConfirmation = observer(function WorktreePromptConfirmation({
  confirmation,
  actions,
}: {
  confirmation: { readonly id: string; readonly estimatedTokens: number };
  actions: Pick<WorktreeStore, "confirmAgentPrompt" | "confirmingPrompt">;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selected = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const choose = useCallback(
    (decision: "run" | "cancel" | "tool-prune") => {
      if (selected.current) return;
      selected.current = true;
      setSubmitting(true);
      clearTimeout(timer.current);
      timer.current = undefined;
      void actions.confirmAgentPrompt(decision).then((accepted) => {
        if (!accepted) {
          selected.current = false;
          setSubmitting(false);
        }
      });
    },
    [actions],
  );

  useEffect(() => {
    selected.current = false;
    setSubmitting(false);
    timer.current = setTimeout(() => choose("run"), RUN_DELAY_MS);
    return () => clearTimeout(timer.current);
  }, [confirmation.id, choose]);

  return (
    <Confirmation
      state="requested"
      className="mx-2"
      role="group"
      aria-label="Agent request confirmation"
      tabIndex={0}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.target === event.currentTarget &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          choose("run");
        }
      }}
    >
      <ConfirmationRequest>
        <ConfirmationTitle>Run this agent request?</ConfirmationTitle>
        <ConfirmationDescription>
          About {Math.round(confirmation.estimatedTokens / 1000)}K context tokens; prompt cache may
          have expired. Tool prune keeps dialogue and removes tool activity without a model summary.
        </ConfirmationDescription>
        <ConfirmationActions>
          <ConfirmationAction
            variant="outline"
            disabled={submitting || actions.confirmingPrompt}
            onClick={() => choose("cancel")}
          >
            Cancel
          </ConfirmationAction>
          <ConfirmationAction
            variant="outline"
            disabled={submitting || actions.confirmingPrompt}
            onClick={() => choose("tool-prune")}
          >
            Tool prune and run
          </ConfirmationAction>
          <ConfirmationAction
            aria-label="Run"
            disabled={submitting || actions.confirmingPrompt}
            onClick={() => choose("run")}
          >
            <svg
              key={confirmation.id}
              width="14"
              height="14"
              viewBox="0 0 16 16"
              role="img"
              aria-label="Runs automatically when countdown completes"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                opacity="0.25"
              />
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                pathLength="1"
                strokeDasharray="1"
                transform="rotate(-90 8 8)"
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="0"
                  to="1"
                  dur={`${RUN_DELAY_MS}ms`}
                  fill="freeze"
                />
              </circle>
            </svg>
            Run
          </ConfirmationAction>
        </ConfirmationActions>
      </ConfirmationRequest>
    </Confirmation>
  );
});
