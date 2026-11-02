import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Button } from "../ui/button";
import { SegmentedControlGroup, SegmentedControlButton } from "../ui/segmented-control";
import { AutomationTriggerFields } from "./automation-trigger-fields";
import { AutomationTaskFields } from "./automation-task-fields";
import { AutomationContextField } from "./automation-context-field";

export const AutomationDefinition = observer(function AutomationDefinition() {
  const hub = useStore(RootStore).automationsStore;
  const editor = hub.editor;
  const definition = editor.definition;
  if (!definition) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <fieldset disabled={editor.saving} className="mx-auto min-w-0 max-w-6xl">
          <label className="mb-5 grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
            <span className="text-muted-foreground">Name</span>
            <Input
              aria-label="Automation name"
              value={definition.name}
              onChange={(event) => editor.patch({ name: event.currentTarget.value })}
            />
          </label>
          {editor.creating && (
            <SegmentedControlGroup aria-label="New automation steps" className="mb-5">
              {(["context", "trigger", "task"] as const).map((step) => (
                <SegmentedControlButton
                  key={step}
                  active={editor.step === step}
                  onClick={() => editor.setStep(step)}
                >
                  {step[0]!.toUpperCase() + step.slice(1)}
                </SegmentedControlButton>
              ))}
            </SegmentedControlGroup>
          )}
          <div className="grid items-start gap-7 min-[1050px]:grid-cols-[minmax(0,1fr)_15rem]">
            <div className="grid min-w-0 gap-5">
              {editor.creating && editor.step === "context" && (
                <section className="rounded-lg border border-border/75 p-4">
                  <AutomationContextField />
                </section>
              )}
              {(!editor.creating || editor.step === "trigger") && <AutomationTriggerFields />}
              {(!editor.creating || editor.step === "task") && <AutomationTaskFields />}
            </div>
            {(!editor.creating || editor.step === "task") && (
              <aside
                className="grid gap-5 text-xs min-[1050px]:border-l min-[1050px]:border-border/65 min-[1050px]:pl-6"
                aria-label="Automation execution settings"
              >
                <h2 className="font-semibold">Execution</h2>
                <label className="grid gap-2 border-t border-border/65 pt-4">
                  When already running
                  <Select
                    aria-label="When already running"
                    value={definition.overlap}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === "skip" || value === "queue" || value === "parallel")
                        editor.patch({ overlap: value });
                    }}
                  >
                    <option value="skip">Skip new occurrence</option>
                    <option value="queue">Queue new occurrence</option>
                    <option value="parallel">Run in parallel</option>
                  </Select>
                </label>
                <label className="grid gap-2 border-t border-border/65 pt-4">
                  On successful completion
                  <Select
                    aria-label="On successful completion"
                    value={definition.completion}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === "auto-resolve" || value === "keep-for-review")
                        editor.patch({ completion: value });
                    }}
                  >
                    <option value="auto-resolve">Auto-resolve session</option>
                    <option value="keep-for-review">Keep for review</option>
                  </Select>
                </label>
                <div className="flex justify-between gap-2 border-t border-border/65 pt-4">
                  <span className="text-muted-foreground">Failed / canceled</span>
                  <span>Keep for review</span>
                </div>
                <div className="flex justify-between gap-2 border-t border-border/65 pt-4">
                  <span className="text-muted-foreground">Memory view</span>
                  <span>10,000 bytes</span>
                </div>
                {editor.creating && (
                  <label className="grid gap-2 border-t border-border/65 pt-4">
                    Save as
                    <Select
                      aria-label="Initial automation state"
                      value={editor.initialState}
                      onChange={(event) => {
                        editor.initialState =
                          event.currentTarget.value === "paused" ? "paused" : "active";
                      }}
                    >
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                    </Select>
                  </label>
                )}
              </aside>
            )}
          </div>
        </fieldset>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-border/65 px-8 py-3">
        {editor.creating && editor.step !== "context" && (
          <Button
            variant="outline"
            onClick={() => editor.setStep(editor.step === "task" ? "trigger" : "context")}
          >
            Previous
          </Button>
        )}
        {editor.creating && editor.step !== "task" ? (
          <Button onClick={() => editor.setStep(editor.step === "context" ? "trigger" : "task")}>
            Next
          </Button>
        ) : (
          <Button
            disabled={
              editor.saving ||
              !definition.name.trim() ||
              !definition.task.prompt.trim() ||
              !definition.task.configuration.provider ||
              !definition.task.configuration.modelId
            }
            onClick={() => void hub.save()}
          >
            {editor.saving ? "Saving…" : editor.creating ? "Create automation" : "Save changes"}
          </Button>
        )}
      </footer>
    </div>
  );
});
