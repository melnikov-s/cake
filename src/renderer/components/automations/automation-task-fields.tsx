import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { ModelPicker } from "../model-picker";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { AttachmentTile } from "../ui/attachment-tile";
import { AutomationContextField } from "./automation-context-field";

export const AutomationTaskFields = observer(function AutomationTaskFields() {
  const root = useStore(RootStore);
  const editor = root.automationsStore.editor;
  const task = editor.definition?.task;
  if (!task) return null;
  return (
    <section className="rounded-lg border border-border/75" aria-label="Run task">
      <h2 className="border-b border-border/65 px-4 py-3 text-xs font-semibold">Run task</h2>
      <div className="grid gap-4 p-4">
        <AutomationContextField />
        <Textarea
          dictation
          aria-label="Automation task"
          className="min-h-40 text-sm leading-relaxed"
          value={task.prompt}
          onChange={(event) =>
            editor.patch({ task: { ...task, prompt: event.currentTarget.value } })
          }
        />
        <div className="flex flex-wrap gap-2">
          {task.attachments.map((attachment, index) => (
            <AttachmentTile
              key={index}
              name={"name" in attachment ? attachment.name : "Annotations"}
              onRemove={() => editor.removeAttachment(index)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={editor.choosingAttachments}
            onClick={() => void editor.addAttachments()}
          >
            Attach
          </Button>
          <ModelPicker
            ariaLabel="Automation model"
            placeholder="Choose model"
            groups={() => root.modelCatalogStore.modelsByProvider}
            onOpen={() => void root.modelCatalogStore.ensureLoaded()}
            value={task.configuration}
            presets={root.settingsStore.modelPresets.presets}
            utilityModel={root.settingsStore.utilityModel.model}
            onSelect={(configuration) => editor.patch({ task: { ...task, configuration } })}
            onSelectPreset={(preset) =>
              editor.patch({
                task: {
                  ...task,
                  configuration: {
                    provider: preset.provider,
                    modelId: preset.modelId,
                    thinkingLevel: preset.thinkingLevel,
                    fastMode: preset.fastMode,
                    preset: {
                      id: preset.id,
                      ...(preset.prompt ? { prompt: preset.prompt } : null),
                    },
                  },
                },
              })
            }
            openPresetSettings={() => root.navigationStore.showModelPresetSettings()}
          />
        </div>
      </div>
    </section>
  );
});
