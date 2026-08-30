import { useEffect, useState, type FormEvent } from "react";
import { observer } from "r-state-tree/react";
import type { ModelPreset } from "../../ipc/session-contract";
import type { ModelGroup } from "./model-picker";
import { ModelPicker, reasoningLabel } from "./model-picker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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

  return (
    <section className="border-t border-border py-5" aria-labelledby="model-presets-title">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id="model-presets-title" className="text-[15px] font-semibold text-foreground">
            Model Presets
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Save a model, reasoning level, and Fast mode as one reusable configuration. New sessions
            use the default preset, or your last selected model when no default is set.
          </p>
        </div>
        <Button size="sm" type="button" onClick={() => begin()}>
          New preset
        </Button>
      </header>
      <div className="grid gap-3">
        {settings.presets.length === 0 && !editingId && (
          <p className="text-xs text-muted-foreground">
            No presets yet. Create one for your preferred setup.
          </p>
        )}
        {settings.presets.map((preset) => (
          <article
            key={preset.id}
            className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/50 p-3"
          >
            <div>
              <strong className="block text-xs font-semibold text-foreground">{preset.name}</strong>
              <small className="block font-mono text-[10px] text-muted-foreground">
                {preset.provider}/{preset.modelId} · {reasoningLabel(preset.thinkingLevel)}
                {preset.fastMode ? " · Fast" : ""}
              </small>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label
                title="Use for new conversations"
                className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <input
                  type="radio"
                  className="accent-primary"
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
            className="w-fit"
            onClick={() => void settings.setDefaultPreset(undefined)}
          >
            Clear default
          </Button>
        )}
      </div>
      {editingId && (
        <form
          className="mt-4 grid gap-4 rounded-xl border border-border bg-card p-4 shadow-sm"
          onSubmit={submit}
        >
          <label className="flex items-center justify-between gap-6 text-sm">
            <span className="text-xs font-medium text-foreground">Name</span>
            <Input
              autoFocus
              className="h-8 max-w-md text-xs"
              value={draft.name}
              maxLength={80}
              placeholder="e.g. Deep review"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className="flex items-center justify-between gap-6 text-sm">
            <span className="text-xs font-medium text-foreground">Model & reasoning</span>
            <ModelPicker
              ariaLabel="Preset model"
              placeholder="Choose model & reasoning"
              groups={groups}
              showFastMode
              value={
                draft.provider && draft.modelId
                  ? {
                      provider: draft.provider,
                      modelId: draft.modelId,
                      thinkingLevel: draft.thinkingLevel,
                      fastMode: draft.fastMode,
                    }
                  : undefined
              }
              onSelect={({ provider, modelId, thinkingLevel, fastMode }) => {
                setDraft({
                  ...draft,
                  provider,
                  modelId,
                  thinkingLevel,
                  fastMode,
                });
              }}
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={() => setEditingId(undefined)}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={!draft.name.trim() || !modelValue || settings.saving}
            >
              Save preset
            </Button>
          </div>
        </form>
      )}
    </section>
  );
});
