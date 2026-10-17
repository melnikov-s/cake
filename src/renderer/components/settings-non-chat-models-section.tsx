import { observer } from "r-state-tree/react";
import type { NonChatModelType } from "../../contracts/models/non-chat-model-data";
import type { NonChatModelSettingsStore } from "../stores/NonChatModelSettingsStore";
import type { ProviderSettingsStore } from "../stores/ProviderSettingsStore";
import { SettingsProvidersSection } from "./settings-providers-section";
import { nonChatModelChoiceValue } from "../lib/non-chat-model-choice";
import { Select } from "./ui/select";
import { Callout } from "./ui/callout";

export const SettingsNonChatModelsSection = observer(function SettingsNonChatModelsSection({
  type,
  preferences,
  providers,
}: {
  type: NonChatModelType;
  preferences: NonChatModelSettingsStore;
  providers: ProviderSettingsStore;
}) {
  const models = providers.nonChatCatalog.filter((model) => model.type === type);
  const preference = preferences.preferences[type];
  const value = preference ? nonChatModelChoiceValue(preference) : "";
  const modelValue = (model: (typeof models)[number]) =>
    nonChatModelChoiceValue({ provider: model.provider, modelId: model.id });
  const selected = models.find((model) => modelValue(model) === value);
  const groups = providers.allModelsByProvider.flatMap((group) => {
    const entries = group.models.filter((model) => "type" in model && model.type === type);
    return entries.length ? [{ ...group, models: entries }] : [];
  });
  const label = type === "image" ? "image" : "classifier";
  return (
    <div className="grid gap-5">
      <section className="grid gap-1.5" aria-labelledby={`setting-${type}-preference`}>
        <h3
          id={`setting-${type}-preference`}
          className="px-0.5 text-xs font-semibold text-foreground"
        >
          Preferred {label} model
        </h3>
        <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
          <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="text-xs font-medium text-foreground">
                Preferred {label} model
              </strong>
              <small className="text-[11px] text-muted-foreground">
                Advisory default when an agent does not specify a {label} model.
              </small>
            </span>
            <Select
              aria-label={`Preferred ${label} model`}
              className="h-8 w-64 rounded-sm text-xs max-[620px]:w-full"
              value={value}
              disabled={providers.loadingModels}
              onChange={(event) => {
                if (event.target.value === "") void preferences.select(type, null);
                else {
                  const model = models.find(
                    (candidate) => modelValue(candidate) === event.target.value,
                  );
                  if (model)
                    void preferences.select(type, { provider: model.provider, modelId: model.id });
                }
              }}
            >
              <option value="">No preference — agent chooses</option>
              {preference && !selected && (
                <option value={value}>
                  {preference.provider}/{preference.modelId} — not in current catalog
                </option>
              )}
              {models.map((model) => (
                <option key={modelValue(model)} value={modelValue(model)}>
                  {model.providerName} / {model.name} ({model.id})
                  {model.available
                    ? ""
                    : model.authenticated
                      ? " — unavailable"
                      : " — credentials required"}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {preferences.saving && (
          <p className="px-0.5 text-xs text-muted-foreground" role="status">
            Saving preference…
          </p>
        )}
        {preference && !selected?.available && (
          <Callout variant="warning">
            This preference is not currently available. Connect its provider or choose another
            model.
          </Callout>
        )}
        <p className="px-0.5 text-[11px] text-muted-foreground">
          {type === "image"
            ? "Requires native codemode in Execution & resources. Generation may incur provider charges."
            : "Requires native codemode in Execution & resources. Choosing a preference does not enable background classification or Auto routing."}
        </p>
      </section>
      <SettingsProvidersSection providers={providers} providerGroups={groups} />
    </div>
  );
});
