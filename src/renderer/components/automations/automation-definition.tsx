import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { RadioGroup } from "../ui/radio-group";
import { AutomationTriggerFields } from "./automation-trigger-fields";
import { AutomationTaskFields } from "./automation-task-fields";
import { AutomationProjectField } from "./automation-project-field";

export const AutomationDefinition = observer(function AutomationDefinition() {
  const hub = useStore(RootStore).automationsStore;
  const editor = hub.editor;
  const definition = editor.definition;
  if (!definition) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <fieldset disabled={editor.saving} className="mx-auto grid min-w-0 max-w-3xl gap-5">
          <div className="grid gap-3">
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Name</span>
              <Input
                aria-label="Automation name"
                value={definition.name}
                onChange={(event) => editor.patch({ name: event.currentTarget.value })}
              />
            </label>
            <AutomationProjectField />
          </div>
          <AutomationTriggerFields />
          <AutomationTaskFields />
          <div className="grid gap-5 border-t border-border/65 pt-5">
            <RadioGroup
              label="When already running"
              value={definition.overlap}
              options={[
                { value: "skip", label: "Skip" },
                { value: "queue", label: "Queue" },
                { value: "parallel", label: "Run in parallel" },
              ]}
              onValueChange={(overlap) => editor.patch({ overlap })}
            />
            <RadioGroup
              label="On successful completion"
              value={definition.completion}
              options={[
                { value: "auto-resolve", label: "Auto-resolve" },
                { value: "keep-for-review", label: "Keep for review" },
              ]}
              onValueChange={(completion) => editor.patch({ completion })}
            />
            {editor.creating && (
              <RadioGroup
                label="Save as"
                value={editor.initialState}
                options={[
                  { value: "active", label: "Active" },
                  { value: "paused", label: "Paused" },
                ]}
                onValueChange={(state) => {
                  editor.initialState = state;
                }}
              />
            )}
          </div>
        </fieldset>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-border/65 px-6 py-3">
        {editor.creating && (
          <Button
            variant="outline"
            className="mr-auto"
            disabled={editor.saving}
            onClick={() => hub.showOverview()}
          >
            Cancel
          </Button>
        )}
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
      </footer>
    </div>
  );
});
