import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { ModelPicker } from "../model-picker";
import { ChatComposer } from "../chat-composer";
import { ComposerInput } from "../ai-elements/composer";
import { Button } from "../ui/button";
import { AttachmentTile } from "../ui/attachment-tile";

export const AutomationTaskFields = observer(function AutomationTaskFields() {
  const root = useStore(RootStore);
  const editor = root.automationsStore.editor;
  const task = editor.definition?.task;
  if (!task) return null;
  return (
    <section className="grid min-w-0 gap-2" aria-label="Prompt">
      <h2 className="text-xs font-medium">Prompt</h2>
      <ChatComposer
        className="max-w-none"
        onSubmit={(event) => event.preventDefault()}
        input={
          <ComposerInput
            aria-label="Automation task"
            placeholder="What should this automation do?"
            className="min-h-24"
            value={task.prompt}
            onChange={(event) =>
              editor.patch({ task: { ...task, prompt: event.currentTarget.value } })
            }
          />
        }
        toolbarLeading={
          <Button
            size="sm"
            variant="ghost"
            disabled={editor.choosingAttachments}
            onClick={() => void editor.addAttachments()}
          >
            Attach
          </Button>
        }
        toolbarActions={
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
        }
      >
        {task.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pb-2">
            {task.attachments.map((attachment, index) => (
              <AttachmentTile
                key={index}
                name={"name" in attachment ? attachment.name : "Annotations"}
                onRemove={() => editor.removeAttachment(index)}
              />
            ))}
          </div>
        )}
      </ChatComposer>
    </section>
  );
});
