import { useState } from "react";
import { observer } from "r-state-tree/react";
import {
  cakeChatModelSettingDefaults,
  type CakeChatModelSetting,
} from "../../contracts/cake-chats/cake-chat-preferences";
import type { CakeModelChoice } from "../../contracts/model-presets/cake-model-selection";
import type { SettingsStore } from "../stores/SettingsStore";
import { ModelPicker } from "./model-picker";
import { Select } from "./ui/select";

const PRESET_PREFIX = "preset:";

/** Chooses one Cake Chat model setting: Inherit, Default preset, Utility, a preset, or a model. */
export const SettingsModelChoiceField = observer(function SettingsModelChoiceField({
  settings,
  setting,
  label,
  description,
}: {
  settings: SettingsStore;
  setting: CakeChatModelSetting;
  label: string;
  description: string;
}) {
  const store = settings.cakeChat;
  const fallback: CakeModelChoice = cakeChatModelSettingDefaults[setting];
  const stored = store.preferences[setting] ?? fallback;
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
  // One parenthetical per option, e.g. "Utility model (default, gpt-mini)".
  const optionLabel = (name: string, source: CakeModelChoice["source"], detail?: string) => {
    const notes = [source === fallback.source ? "default" : undefined, detail].filter(Boolean);
    return notes.length > 0 ? `${name} (${notes.join(", ")})` : name;
  };

  const choose = (next: string) => {
    setChoosingModel(false);
    if (next.startsWith(PRESET_PREFIX))
      return void store.setModelChoice(setting, {
        source: "preset",
        presetId: next.slice(PRESET_PREFIX.length),
      });
    switch (next) {
      case "default":
      case "inherit":
      case "utility":
        return void store.setModelChoice(setting, { source: next });
      case "model":
        if (stored.source !== "model") setChoosingModel(true);
        return;
    }
  };

  return (
    <div className="flex items-center justify-between gap-6 text-sm">
      <span className="flex flex-col gap-1">
        <strong className="text-xs font-medium">{label}</strong>
        <small className="text-[11px] text-muted-foreground">{description}</small>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-2">
        <Select
          aria-label={label}
          className="w-64"
          value={value}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="inherit">{optionLabel("Inherit chat model", "inherit")}</option>
          <option value="default">
            {optionLabel("Default preset", "default", defaultPreset?.name)}
          </option>
          <option value="utility" disabled={!utility && stored.source !== "utility"}>
            {optionLabel("Utility model", "utility", utility?.modelId ?? "not configured")}
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
            ariaLabel={`${label} configuration`}
            placeholder="Choose model"
            groups={() => settings.providerGroups}
            value={stored.source === "model" ? stored.model : undefined}
            currentModelName={stored.source === "model" ? stored.model.modelId : undefined}
            onSelect={(model) => {
              setChoosingModel(false);
              void store.setModelChoice(setting, { source: "model", model });
            }}
          />
        )}
      </span>
    </div>
  );
});
