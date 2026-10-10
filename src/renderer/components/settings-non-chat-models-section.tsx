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
    <>
      <section
        className="border-t border-border py-5"
        aria-labelledby={`setting-${type}-preference`}
      >
        <h3 id={`setting-${type}-preference`} className="text-[15px] font-semibold text-foreground">
          Preferred {label} model
        </h3>
        <p className="my-3 text-xs leading-relaxed text-muted-foreground">
          Saved on your Cake backend. Eligible Project Session agents use this preference when
          choosing a model; it is not a restriction. An explicit requested model always takes
          precedence. No preference leaves the choice to the agent. These models never change your
          chat model.
        </p>
        <Select
          aria-label={`Preferred ${label} model`}
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
        {preferences.saving && (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            Saving preference…
          </p>
        )}
        {preference && !selected?.available && (
          <Callout variant="warning" className="mt-3">
            This preference is not currently available. Connect its provider or choose another
            model. The agent receives an explicit error instead of silently substituting a billed
            model.
          </Callout>
        )}
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {type === "image"
            ? "Pi’s built-in image models currently use OpenRouter API credentials, not a ChatGPT subscription. Generation can incur provider charges; images are only saved when you request it."
            : "Classifiers answer typed questions about JSON state through Pi. Choosing a preference does not enable background classification or Auto routing."}{" "}
          Native codemode must be enabled in Execution & resources. Restricted chats do not gain
          tools from this preference.
        </p>
      </section>
      <SettingsProvidersSection providers={providers} providerGroups={groups} />
    </>
  );
});
