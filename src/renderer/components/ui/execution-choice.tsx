import { useState, type ReactNode } from "react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationTitle,
} from "../ai-elements/confirmation";
import { Button } from "./button";

/** One execution choice, not a permission policy or a persistent mode. */
export function ExecutionChoice({
  title,
  description,
  ownerLabel,
  phases,
  script,
  onRun,
  onNormal,
  onCancel,
}: {
  title: string;
  description: string;
  ownerLabel: string;
  phases: readonly string[];
  script: ReactNode;
  onRun(): void;
  onNormal(): void;
  onCancel(): void;
}) {
  const [showScript, setShowScript] = useState(false);
  return (
    <Confirmation
      state="requested"
      role="alertdialog"
      aria-labelledby="execution-choice-title"
      aria-describedby="execution-choice-description"
      className="max-h-[85vh] w-full max-w-2xl overflow-auto"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <ConfirmationTitle id="execution-choice-title">{title}</ConfirmationTitle>
      <ConfirmationDescription id="execution-choice-description">
        {description}
      </ConfirmationDescription>
      <div className="mt-3 rounded-lg border border-border/75 bg-muted/25 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 break-all font-mono text-xs text-muted-foreground">
            Project owner: {ownerLabel}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-expanded={showScript}
            aria-controls="execution-choice-script"
            onClick={() => setShowScript((current) => !current)}
          >
            {showScript ? "Hide script" : "View script"}
          </Button>
        </div>
        {phases.length > 0 ? (
          <ol
            aria-label="Proposed phases"
            className="mt-2.5 list-inside list-decimal space-y-1 border-t border-border/60 pt-2.5 text-xs text-foreground"
          >
            {phases.map((phase, index) => (
              <li key={`${index}:${phase}`}>{phase}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-2.5 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
            No phases declared.
          </p>
        )}
      </div>
      {showScript && (
        <div
          id="execution-choice-script"
          role="region"
          aria-label="Proposed workflow script"
          className="mt-3"
        >
          {script}
        </div>
      )}
      <ConfirmationActions className="flex-wrap">
        <ConfirmationAction variant="ghost" onClick={onCancel}>
          Cancel
        </ConfirmationAction>
        <ConfirmationAction variant="outline" autoFocus onClick={onNormal}>
          Continue normally
        </ConfirmationAction>
        <ConfirmationAction onClick={onRun}>Run workflow</ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}
