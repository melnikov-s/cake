import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { SettingsStore } from "../stores/SettingsStore";
import { ModelPicker } from "./model-picker";
import { Select } from "./ui/select";

const PRESET_PREFIX = "preset:";

/** Chooses what subagents launched without an explicit model use. */
export const SettingsSubagentModelField = observer(function SettingsSubagentModelField({
  settings,
}: {
  settings: SettingsStore;
}) {
  const store = settings.cakeChat;
  const stored = store.preferences.subagentDefaultModel ?? { source: "inherit" };
  const presets = settings.modelPresets.presets;
  const defaultPreset = presets.find(
    (preset) => preset.id === settings.modelPresets.defaultPresetId,
  );
  const utility = settings.utilityModel.model;
  // "Specific model" needs a picked model before it can be saved.
  const [choosingModel, setChoosingModel] = useState(false);
  const value = choosingModel
    ? "model"
    : stored.source === "preset"
      ? `${PRESET_PREFIX}${stored.presetId}`
      : stored.source;
  const missingPresetId =
    stored.source === "preset" && !presets.some((preset) => preset.id === stored.presetId)
      ? stored.presetId
      : undefined;

  const choose = (next: string) => {
    setChoosingModel(false);
    if (next.startsWith(PRESET_PREFIX))
      return void store.setSubagentDefaultModel({
        source: "preset",
        presetId: next.slice(PRESET_PREFIX.length),
      });
    switch (next) {
      case "default":
      case "inherit":
      case "utility":
        return void store.setSubagentDefaultModel({ source: next });
      case "model":
        if (stored.source !== "model") setChoosingModel(true);
        return;
    }
  };

  return (
    <div className="flex items-center justify-between gap-6 text-sm">
      <span className="flex flex-col gap-1">
        <strong className="text-xs font-medium">Subagent default model</strong>
        <small className="text-[11px] text-muted-foreground">
          Used when Cake Chat starts a subagent without choosing a model. Inherit (the default) uses
          the chat's current model, thinking level, and Fast mode. Project Session subagents and new
          sessions use the default preset.
        </small>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-2">
        <Select
          aria-label="Subagent default model"
          className="w-56"
          value={value}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="inherit">Inherit chat model (default)</option>
          <option value="default">
            Default preset{defaultPreset ? ` (${defaultPreset.name})` : ""}
          </option>
          <option value="utility" disabled={!utility && stored.source !== "utility"}>
            Utility model{utility ? ` (${utility.modelId})` : " (not configured)"}
          </option>
          {presets.length > 0 && (
            <optgroup label="Presets">
              {presets.map((preset) => (
                <option key={preset.id} value={`${PRESET_PREFIX}${preset.id}`}>
                  {preset.name}
                </option>
              ))}
            </optgroup>
          )}
          {missingPresetId && (
            <option value={`${PRESET_PREFIX}${missingPresetId}`}>Deleted preset</option>
          )}
          <option value="model">Specific model…</option>
        </Select>
        {value === "model" && (
          <ModelPicker
            ariaLabel="Subagent default model configuration"
            placeholder="Choose model"
            groups={() => settings.providerGroups}
            value={stored.source === "model" ? stored.model : undefined}
            currentModelName={stored.source === "model" ? stored.model.modelId : undefined}
            onSelect={(model) => {
              setChoosingModel(false);
              void store.setSubagentDefaultModel({ source: "model", model });
            }}
          />
        )}
      </span>
    </div>
  );
});
