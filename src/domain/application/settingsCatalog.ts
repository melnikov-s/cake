import { Effect, Schema } from "effect";
import {
  CakePromptKey,
  settingTypeSummary,
  settingsCatalog,
  settingsCategories,
  settingsElsewhere,
  settingsNotAgentWritable,
  type SettingDefinition,
  type SettingsGetInput,
  type SettingsListInput,
  type SettingsUpdateInput,
} from "../../contracts/application/settings-catalog";
import {
  CakeChatPreferences,
  ExperimentalFeatures,
  UtilityModel,
  type ApplicationState as ApplicationStateValue,
} from "../../contracts/application/application-data";
import {
  defaultCakePrompts,
  resolveCakePrompts,
} from "../../contracts/application/cake-prompt-defaults";
import {
  DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS,
  cakeChatModelSettingDefaults,
  defaultCakeChatPreferences,
} from "../../contracts/cake-chats/cake-chat-preferences";
import { CakeModelChoice } from "../../contracts/model-presets/cake-model-selection";
import { NonChatModelReference } from "../../contracts/models/non-chat-model-data";
import {
  piSettingUpdateSchema,
  type PiSettings as PiSettingsValue,
} from "../../contracts/conversations/session-contract";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { PiSettings } from "../../services/pi/PiSettings";
import { toJsonValue } from "../../utils/to-json-value";
import * as application from "./application";
import * as piSettings from "./piSettings";
import * as modelPresets from "../model-presets/modelPresets";
import { updateNonChatModelPreference } from "../model-preferences/non-chat-model-preferences";

export class SettingsCatalogError extends Schema.TaggedError<SettingsCatalogError>()(
  "SettingsCatalogError",
  { message: Schema.String },
) {}

/** Long text is previewed in list rows and update echoes; settings.get returns it in full. */
const LIST_TEXT_LIMIT = 60;
const ECHO_TEXT_LIMIT = 200;

const definitionFor = (key: string): Effect.Effect<SettingDefinition, SettingsCatalogError> => {
  const definition = settingsCatalog.find((candidate) => candidate.key === key);
  return definition
    ? Effect.succeed(definition)
    : Effect.fail(
        new SettingsCatalogError({
          message: `Unknown setting: ${key}. Find keys with settings.list (categories) or settings.list {query}.`,
        }),
      );
};

/** Narrow an already-validated value to the authority's own type, without casts. */
const typed = <T>(schema: Schema.ConstraintDecoder<T, never>, key: string, value: JsonValue) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new SettingsCatalogError({ message: `Invalid value for ${key}: ${cause.message}` }),
    ),
  );

function piValue(settings: PiSettingsValue, key: string): JsonValue {
  if (key === "defaultModel")
    return settings.defaultProvider && settings.defaultModel
      ? { provider: settings.defaultProvider, modelId: settings.defaultModel }
      : null;
  return toJsonValue(Object.entries(settings).find(([name]) => name === key)?.[1] ?? null);
}

function applicationValue(state: ApplicationStateValue, key: string) {
  const chat = state.cakeChatPreferences ?? defaultCakeChatPreferences();
  const prompt = key.startsWith("prompts.") ? key.slice("prompts.".length) : undefined;
  if (prompt !== undefined)
    return Object.entries(resolveCakePrompts(state.cakePrompts)).find(
      ([name]) => name === prompt,
    )?.[1];
  switch (key) {
    case "cakeChat.contextLimitTokens":
      return chat.contextLimitTokens ?? DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS;
    case "cakeChat.memoryViewBytes":
      return chat.memoryViewBytes;
    case "cakeChat.summarizationModel":
      return chat.summarizationModel ?? cakeChatModelSettingDefaults.summarizationModel;
    case "cakeChat.subagentDefaultModel":
      return chat.subagentDefaultModel ?? cakeChatModelSettingDefaults.subagentDefaultModel;
    case "models.defaultPreset":
      return state.defaultModelPresetId ?? null;
    case "models.utility":
      return state.utilityModel ?? null;
    case "models.imagePreference":
      return state.nonChatModelPreferences?.image ?? null;
    case "models.classifierPreference":
      return state.nonChatModelPreferences?.classifier ?? null;
    case "instructions.global":
      return state.globalCustomInstructions;
    case "experimental.dynamicWorkflows":
      return state.experimentalFeatures?.dynamicWorkflows ?? false;
  }
  return undefined;
}

function defaultValue(key: string, piDefaults: PiSettingsValue | undefined) {
  if (key.startsWith("pi.")) return piDefaults ? piValue(piDefaults, key.slice(3)) : null;
  if (key.startsWith("prompts."))
    return Object.entries(defaultCakePrompts()).find(
      ([name]) => name === key.slice("prompts.".length),
    )?.[1];
  switch (key) {
    case "cakeChat.contextLimitTokens":
      return DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS;
    case "cakeChat.memoryViewBytes":
      return defaultCakeChatPreferences().memoryViewBytes;
    case "cakeChat.summarizationModel":
      return cakeChatModelSettingDefaults.summarizationModel;
    case "cakeChat.subagentDefaultModel":
      return cakeChatModelSettingDefaults.subagentDefaultModel;
    case "instructions.global":
      return "";
    case "experimental.dynamicWorkflows":
      return false;
  }
  return null;
}

/** Read every value from its authority; Pi's settings file is read once per call. */
const snapshot = Effect.fn("SettingsCatalog.snapshot")(function* (keys: readonly string[]) {
  const state = (yield* ApplicationState).snapshot();
  const needsPi = keys.some((key) => key.startsWith("pi."));
  const pi = needsPi ? yield* PiSettings : undefined;
  const current = pi ? yield* pi.load() : undefined;
  const defaults = pi ? yield* pi.defaults() : undefined;
  return {
    value: (key: string): JsonValue =>
      toJsonValue(
        key.startsWith("pi.") && current
          ? piValue(current, key.slice(3))
          : (applicationValue(state, key) ?? null),
      ),
    defaultValue: (key: string): JsonValue => toJsonValue(defaultValue(key, defaults) ?? null),
    reloadPending: current?.reloadPending ?? false,
  };
});

const preview = (value: JsonValue, limit: number): JsonValue =>
  Schema.is(Schema.String)(value) && value.length > limit
    ? `${value.slice(0, limit)}… (${value.length} chars)`
    : value;

const same = (left: JsonValue, right: JsonValue) => JSON.stringify(left) === JSON.stringify(right);

/** Only where the effective result says more than the stored value. */
function effectiveValue(key: string, value: JsonValue, reloadPending: boolean) {
  if (key === "cakeChat.contextLimitTokens") return { effective: { configuredLimitTokens: value } };
  if (key.startsWith("pi.") && reloadPending) return { effective: { reloadPending: true } };
  return null;
}

const matches = (definition: SettingDefinition, query: string) =>
  [definition.key, definition.label, definition.description, definition.category].some((part) =>
    part.toLowerCase().includes(query.toLowerCase()),
  );

/** Without arguments: categories and where other settings live. With category/query: rows. */
export const list = Effect.fn("SettingsCatalog.list")(function* (input: SettingsListInput) {
  const { category, query } = input;
  const selected =
    category === undefined && query === undefined
      ? settingsCatalog
      : settingsCatalog.filter(
          (definition) =>
            (category === undefined || definition.category === category) &&
            (query === undefined || matches(definition, query)),
        );
  const values = yield* snapshot(selected.map((definition) => definition.key));
  const changed = (definition: SettingDefinition) =>
    !same(values.value(definition.key), values.defaultValue(definition.key));
  if (category === undefined && query === undefined)
    return {
      categories: settingsCategories.map((name) => {
        const members = selected.filter((definition) => definition.category === name);
        return {
          category: name,
          settings: members.length,
          changed: members.filter(changed).length,
        };
      }),
      elsewhere: settingsElsewhere,
      notAgentWritable: settingsNotAgentWritable,
    };
  return {
    settings: selected.map((definition) => {
      const value = values.value(definition.key);
      return {
        key: definition.key,
        value: preview(value, LIST_TEXT_LIMIT),
        ...(changed(definition)
          ? { default: preview(values.defaultValue(definition.key), LIST_TEXT_LIMIT) }
          : null),
        type: settingTypeSummary(definition),
      };
    }),
  };
});

export const get = Effect.fn("SettingsCatalog.get")(function* (input: SettingsGetInput) {
  const definition = yield* definitionFor(input.key);
  const values = yield* snapshot([definition.key]);
  const value = values.value(definition.key);
  return {
    key: definition.key,
    category: definition.category,
    label: definition.label,
    description: definition.description,
    type: settingTypeSummary(definition),
    value,
    default: values.defaultValue(definition.key),
    ...effectiveValue(definition.key, value, values.reloadPending),
  };
});

/** Persist one validated value through the same domain operation the Settings UI uses. */
const write = Effect.fn("SettingsCatalog.write")(function* (key: string, value: JsonValue) {
  if (key.startsWith("pi.")) {
    const piKey = key.slice(3);
    const update = yield* typed(
      piSettingUpdateSchema,
      key,
      piKey === "defaultModel"
        ? {
            key: piKey,
            ...(yield* typed(Schema.Record(Schema.String, Schema.Json), key, value)),
          }
        : { key: piKey, value },
    );
    yield* piSettings.update(update);
    return;
  }
  if (key.startsWith("prompts.")) {
    const promptKey = yield* typed(CakePromptKey, key, key.slice("prompts.".length));
    yield* application.setCakePrompt(
      promptKey,
      yield* typed(Schema.NullOr(Schema.String), key, value),
    );
    return;
  }
  switch (key) {
    case "cakeChat.contextLimitTokens": {
      const contextLimitTokens = yield* typed(
        CakeChatPreferences.fields.contextLimitTokens,
        key,
        value,
      );
      yield* application.updateCakeChatPreferences((current) => ({
        ...current,
        contextLimitTokens,
      }));
      return;
    }
    case "cakeChat.memoryViewBytes": {
      const memoryViewBytes = yield* typed(CakeChatPreferences.fields.memoryViewBytes, key, value);
      yield* application.updateCakeChatPreferences((current) => ({
        ...current,
        memoryViewBytes,
      }));
      return;
    }
    case "cakeChat.summarizationModel":
    case "cakeChat.subagentDefaultModel": {
      const setting =
        key === "cakeChat.summarizationModel" ? "summarizationModel" : "subagentDefaultModel";
      const choice = yield* typed(CakeModelChoice, key, value);
      if (
        choice.source === "preset" &&
        !(yield* ApplicationState)
          .snapshot()
          .modelPresets.some((preset) => preset.id === choice.presetId)
      )
        return yield* new SettingsCatalogError({
          message: `Unknown preset ${choice.presetId}; use an ID from settings.models.get.`,
        });
      // Choosing the setting's default source stores nothing, matching Settings.
      yield* application.updateCakeChatPreferences((current) => {
        const next = { ...current };
        delete next[setting];
        return choice.source === cakeChatModelSettingDefaults[setting].source
          ? next
          : { ...next, [setting]: choice };
      });
      return;
    }
    case "models.defaultPreset": {
      const id = yield* typed(Schema.NullOr(Schema.String), key, value);
      yield* modelPresets.setDefault(id ?? undefined);
      return;
    }
    case "models.utility": {
      const model = yield* typed(Schema.NullOr(UtilityModel), key, value);
      yield* application.setUtilityModel(model ?? undefined);
      return;
    }
    case "models.imagePreference":
    case "models.classifierPreference": {
      const preference = yield* typed(Schema.NullOr(NonChatModelReference), key, value);
      yield* updateNonChatModelPreference({
        type: key === "models.imagePreference" ? "image" : "classifier",
        preference,
      });
      return;
    }
    case "instructions.global": {
      yield* application.setGlobalCustomInstructions(yield* typed(Schema.String, key, value));
      return;
    }
    case "experimental.dynamicWorkflows": {
      const dynamicWorkflows = yield* typed(
        ExperimentalFeatures.fields.dynamicWorkflows,
        key,
        value,
      );
      const current = (yield* ApplicationState).snapshot().experimentalFeatures;
      yield* application.setExperimentalFeatures({ ...current, dynamicWorkflows });
      return;
    }
  }
  return yield* new SettingsCatalogError({ message: `Setting ${key} is not writable` });
});

export const update = Effect.fn("SettingsCatalog.update")(function* (input: SettingsUpdateInput) {
  const definition = yield* definitionFor(input.key);
  // The catalog schema carries the Settings UI's limits (e.g. the offered context limits).
  yield* typed(definition.value, definition.key, input.value);
  const previous = (yield* snapshot([definition.key])).value(definition.key);
  yield* write(definition.key, input.value);
  const committed = yield* snapshot([definition.key]);
  const next = committed.value(definition.key);
  return {
    key: definition.key,
    label: definition.label,
    previous: preview(previous, ECHO_TEXT_LIMIT),
    value: preview(next, ECHO_TEXT_LIMIT),
    ...effectiveValue(definition.key, next, committed.reloadPending),
  };
});
