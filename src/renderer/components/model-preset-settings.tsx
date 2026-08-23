import { useEffect, useState, type FormEvent } from "react";
import { observer } from "r-state-tree/react";
import type { ModelPreset, ThinkingLevel } from "../../ipc/session-contract";
import type { ModelGroup } from "./model-combobox";
import { ModelCombobox } from "./model-combobox";
import { ThinkingLevelSelect } from "./thinking-level-select";
import { Button } from "./ui/button";
import type { ModelPresetSettingsStore } from "../stores/ModelPresetSettingsStore";

const emptyDraft = (): Omit<ModelPreset, "id"> => ({
  name: "",
  provider: "",
  modelId: "",
  thinkingLevel: "off",
  fastMode: false,
});

export const ModelPresetSettings = observer(function ModelPresetSettings({
  settings,
  groups,
}: {
  settings: ModelPresetSettingsStore;
  groups: ModelGroup[];
}) {
  const [editingId, setEditingId] = useState<string | "new" | undefined>();
  const [draft, setDraft] = useState(emptyDraft);

  useEffect(() => {
    if (!settings.sectionRequestRevision) return;
    requestAnimationFrame(() =>
      document.getElementById("model-presets-title")?.scrollIntoView({ behavior: "smooth" }),
    );
  }, [settings.sectionRequestRevision]);

  const begin = (preset?: ModelPreset) => {
    setEditingId(preset?.id ?? "new");
    setDraft(preset ? { ...preset } : emptyDraft());
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.provider || !draft.modelId) return;
    const value = { ...draft, name: draft.name.trim() };
    if (editingId === "new") void settings.createPreset(value);
    else if (editingId) void settings.updatePreset({ ...value, id: editingId });
    setEditingId(undefined);
  };
  const modelValue = draft.provider && draft.modelId ? `${draft.provider}/${draft.modelId}` : "";
  const selectedModel = groups
    .flatMap((group) => group.models)
    .find((model) => `${model.provider}/${model.id}` === modelValue);
  const fastModeAvailable = selectedModel?.fastMode ?? false;

  return (
    <section className="settings-section" aria-labelledby="model-presets-title">
      <header>
        <div>
          <h2 id="model-presets-title">Model Presets</h2>
          <p>Save a model, reasoning level, and Fast mode as one reusable configuration.</p>
        </div>
        <Button size="sm" type="button" onClick={() => begin()}>
          New preset
        </Button>
      </header>
      <div className="model-preset-list">
        {settings.presets.length === 0 && !editingId && (
          <p className="settings-empty">No presets yet. Create one for your preferred setup.</p>
        )}
        {settings.presets.map((preset) => (
          <article key={preset.id}>
            <div>
              <strong>{preset.name}</strong>
              <small>
                {preset.provider}/{preset.modelId} · {preset.thinkingLevel} reasoning
                {preset.fastMode ? " · Fast" : ""}
              </small>
            </div>
            <div className="model-preset-actions">
              <label title="Use for new conversations">
                <input
                  type="radio"
                  name="default-model-preset"
                  checked={settings.defaultPresetId === preset.id}
                  onChange={() => void settings.setDefaultPreset(preset.id)}
                />{" "}
                Default
              </label>
              <Button variant="ghost" size="sm" onClick={() => begin(preset)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void settings.duplicatePreset(preset.id)}
              >
                Duplicate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void settings.deletePreset(preset.id)}
              >
                Delete
              </Button>
            </div>
          </article>
        ))}
        {settings.defaultPresetId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void settings.setDefaultPreset(undefined)}
          >
            Clear default
          </Button>
        )}
      </div>
      {editingId && (
        <form className="model-preset-form" onSubmit={submit}>
          <label>
            <span>Name</span>
            <input
              autoFocus
              value={draft.name}
              maxLength={80}
              placeholder="e.g. Deep review"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className="settings-field">
            <span>Model</span>
            <ModelCombobox
              ariaLabel="Preset model"
              groups={groups}
              value={modelValue}
              variant="settings"
              onSelect={(value) => {
                const separator = value.indexOf("/");
                const model = groups
                  .flatMap((group) => group.models)
                  .find((candidate) => `${candidate.provider}/${candidate.id}` === value);
                setDraft({
                  ...draft,
                  provider: value.slice(0, separator),
                  modelId: value.slice(separator + 1),
                  thinkingLevel: model?.availableThinkingLevels.includes(draft.thinkingLevel)
                    ? draft.thinkingLevel
                    : (model?.availableThinkingLevels[0] ?? "off"),
                  fastMode: model?.fastMode ? draft.fastMode : false,
                });
              }}
            />
          </div>
          <label>
            <span>Reasoning</span>
            <ThinkingLevelSelect
              ariaLabel="Preset reasoning"
              value={draft.thinkingLevel}
              levels={selectedModel?.availableThinkingLevels ?? []}
              disabled={!selectedModel}
              variant="settings"
              onSelect={(thinkingLevel: ThinkingLevel) => setDraft({ ...draft, thinkingLevel })}
            />
          </label>
          <label className="model-preset-fast">
            <span>Fast mode</span>
            <input
              type="checkbox"
              checked={draft.fastMode}
              disabled={!fastModeAvailable}
              onChange={(event) => setDraft({ ...draft, fastMode: event.target.checked })}
            />
          </label>
          <div className="model-preset-form-actions">
            <Button variant="ghost" onClick={() => setEditingId(undefined)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!draft.name.trim() || !modelValue || settings.saving}>
              Save preset
            </Button>
          </div>
        </form>
      )}
    </section>
  );
});
