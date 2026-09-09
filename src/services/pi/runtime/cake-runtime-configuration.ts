import {
  type AgentSession,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { Option, Schema } from "effect";
import {
  resolveCakeModelSelection,
  type CakeModelSelection,
  type ExplicitCakeModelSelection,
} from "../../../domain/cake-model-selection";
import type {
  ChatConfiguration,
  ModelOption,
  PiSettingUpdate,
  ThinkingLevel,
} from "../../../ipc/session-contract";
import {
  applyFastModePayload,
  FastModePayload,
  supportsFastMode,
  type FastModeModel,
} from "../fast-mode";
import { projectModelCatalog } from "../live/PiModelsLive";
import type { CakeRuntimeOptions } from "./cake-runtime";
import type { RuntimeUiRequest } from "./runtime-ui-request";
import { applyPiSetting } from "./settings-translation";

export interface CakeRuntimeConfigurationState {
  readonly fastModeExtension: InlineExtension;
  enabledFastMode(): boolean;
  attachModel(model: FastModeModel | undefined): void;
  setFastMode(enabled: boolean): Promise<void>;
  syncFastMode(): Promise<void>;
}

export function createCakeRuntimeConfigurationState(
  fastModeControl: CakeRuntimeOptions["fastMode"],
): CakeRuntimeConfigurationState {
  let fastMode = fastModeControl?.get() ?? false;
  let currentModel: FastModeModel | undefined;
  const enabledFastMode = () => fastMode && supportsFastMode(currentModel);

  return {
    fastModeExtension: (pi) => {
      pi.on("before_provider_request", (event, context) => {
        const payload = Schema.decodeUnknownOption(FastModePayload)(event.payload);
        return Option.isSome(payload)
          ? applyFastModePayload(payload.value, context.model, enabledFastMode())
          : event.payload;
      });
    },
    enabledFastMode,
    attachModel(model) {
      currentModel = model;
    },
    async setFastMode(enabled) {
      if (fastModeControl) await fastModeControl.set(enabled);
      fastMode = enabled;
    },
    async syncFastMode() {
      if (fastModeControl) fastMode = fastModeControl.get();
    },
  };
}

export interface CakeRuntimeConfiguration {
  modelOptions(): Promise<ModelOption[]>;
  currentModelSelection(): ExplicitCakeModelSelection | undefined;
  resolveModelSelection(selection: CakeModelSelection | undefined): ExplicitCakeModelSelection;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  applyConfiguration(configuration: ChatConfiguration): Promise<void>;
  setFastMode(enabled: boolean): Promise<void>;
  syncFastMode(): Promise<void>;
  setPiSetting(update: PiSettingUpdate): Promise<void>;
  refreshModels(): Promise<void>;
  login(provider: string, authType: "api_key" | "oauth"): Promise<void>;
  logout(provider: string): Promise<void>;
  setOperationModel(selection: CakeModelSelection): Promise<ExplicitCakeModelSelection>;
}

export function createCakeRuntimeConfiguration(input: {
  options: CakeRuntimeOptions;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  session: AgentSession;
  state: CakeRuntimeConfigurationState;
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  emitSnapshot(): Promise<void>;
  emitAuthNotice(tone: "info" | "error", title: string, detail: string): void;
  cancelResponseRetries(): void;
  reportAgentAction(action: "set-model", detail: string): Promise<void>;
}): CakeRuntimeConfiguration {
  const {
    options,
    modelRuntime,
    settingsManager,
    session,
    state,
    requestUi,
    emitSnapshot,
    emitAuthNotice,
    cancelResponseRetries,
    reportAgentAction,
  } = input;

  const updateModel = () => state.attachModel(session.model);

  const setFastModeValue = (enabled: boolean) => state.setFastMode(enabled);
  const enabledFastMode = state.enabledFastMode;

  const currentModelSelection = (): ExplicitCakeModelSelection | undefined =>
    session.model
      ? {
          provider: session.model.provider,
          modelId: session.model.id,
          thinkingLevel: session.thinkingLevel,
          fastMode: enabledFastMode(),
        }
      : undefined;

  const resolveModelSelection = (selection: CakeModelSelection | undefined) =>
    resolveCakeModelSelection(
      selection,
      options.modelPresets?.() ?? { presets: [] },
      currentModelSelection(),
    );

  const setModel = async (provider: string, modelId: string) => {
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
    await session.setModel(model);
    updateModel();
    await emitSnapshot();
  };

  const setOperationModel = async (selection: CakeModelSelection) => {
    const configuration = resolveModelSelection(selection);
    const model = modelRuntime.getModel(configuration.provider, configuration.modelId);
    if (!model) throw new Error(`Unknown model ${configuration.provider}/${configuration.modelId}`);
    const supportedThinkingLevels = getSupportedThinkingLevels(model);
    if (!supportedThinkingLevels.includes(configuration.thinkingLevel))
      throw new Error(
        `Thinking level ${configuration.thinkingLevel} is unavailable for ${configuration.provider}/${configuration.modelId}`,
      );
    if (configuration.fastMode && !supportsFastMode(model))
      throw new Error(
        `Fast mode is unavailable for ${configuration.provider}/${configuration.modelId}`,
      );
    await session.setModel(model);
    updateModel();
    session.setThinkingLevel(configuration.thinkingLevel);
    await setFastModeValue(configuration.fastMode);
    await emitSnapshot();
    await reportAgentAction("set-model", `${configuration.provider}/${configuration.modelId}`);
    return configuration;
  };

  return {
    async modelOptions() {
      return (await projectModelCatalog(modelRuntime, getSupportedThinkingLevels)).map(
        ({ supportedThinkingLevels, input, authTypes, ...model }) => ({
          ...model,
          availableThinkingLevels: [...supportedThinkingLevels],
          input: [...input],
          authTypes: [...authTypes],
        }),
      );
    },
    currentModelSelection,
    resolveModelSelection,
    setModel,
    async setThinkingLevel(level) {
      session.setThinkingLevel(level);
      await emitSnapshot();
    },
    async applyConfiguration(configuration) {
      const model = modelRuntime.getModel(configuration.provider, configuration.modelId);
      if (!model)
        throw new Error(`Unknown model ${configuration.provider}/${configuration.modelId}`);
      await session.setModel(model);
      updateModel();
      session.setThinkingLevel(configuration.thinkingLevel);
      if (!configuration.fastMode || supportsFastMode(model))
        await setFastModeValue(configuration.fastMode);
      await emitSnapshot();
    },
    async setFastMode(enabled) {
      if (enabled && !supportsFastMode(session.model))
        throw new Error("Fast mode is unavailable for the current model");
      await setFastModeValue(enabled);
      await emitSnapshot();
    },
    async syncFastMode() {
      if (options.fastMode) await state.syncFastMode();
    },
    async setPiSetting(update) {
      applyPiSetting(settingsManager, session, update);
      if (update.key === "retryEnabled" && !update.value) cancelResponseRetries();
      await settingsManager.flush();
      await emitSnapshot();
    },
    async refreshModels() {
      await modelRuntime.refresh({ allowNetwork: false });
      await emitSnapshot();
    },
    async login(provider, authType) {
      await modelRuntime.login(provider, authType, {
        async prompt(prompt) {
          const value = await requestUi({
            kind: prompt.type,
            title: "Provider authentication",
            message: prompt.message,
            placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
            options:
              prompt.type === "select"
                ? prompt.options.map((option) => ({ id: option.id, label: option.label }))
                : undefined,
            signal: prompt.signal,
          });
          if (value === undefined) throw new Error("Authentication cancelled");
          return value;
        },
        notify(event) {
          const detail =
            event.type === "auth_url"
              ? event.url
              : event.type === "device_code"
                ? `${event.verificationUri}\nCode: ${event.userCode}`
                : event.message;
          emitAuthNotice("info", "Authentication", detail);
          const url =
            event.type === "auth_url"
              ? event.url
              : event.type === "device_code"
                ? event.verificationUri
                : undefined;
          if (url && options.openExternal) {
            void options.openExternal(url).catch((error) => {
              emitAuthNotice(
                "error",
                "Could not open authentication",
                `${error instanceof Error ? error.message : String(error)}\n${detail}`,
              );
            });
          }
        },
      });
      await emitSnapshot();
    },
    async logout(provider) {
      const status = modelRuntime.getProviderAuthStatus(provider);
      if (
        status.configured &&
        status.source &&
        status.source !== "stored" &&
        status.source !== "runtime"
      ) {
        throw new Error(
          `${status.label ?? provider} is managed outside Cake. Remove that credential source and restart Cake to disconnect it.`,
        );
      }
      await modelRuntime.logout(provider);
      await emitSnapshot();
    },
    setOperationModel,
  };
}
