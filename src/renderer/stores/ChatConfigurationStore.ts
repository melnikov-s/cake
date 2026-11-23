import { isAntigravityModel } from "../../contracts/model-presets/antigravity-model";
import { Store, computed } from "r-state-tree";
import type {
  ChatConfiguration,
  ModelOption,
  ModelPreset,
  ThinkingLevel,
} from "../../contracts/conversations/session-contract";
import type { Conversation } from "../models/Conversation";
import { ModelOption as RuntimeModelOption } from "../models/ModelOption";
import { describeError } from "../lib/error-details";
import { ModelCatalogContext } from "./context/ModelCatalogContext";
import { UtilityModelContext } from "./context/UtilityModelContext";

export interface ChatConfigurationStoreProps {
  session(): Conversation | undefined;
  antigravityAvailable?(): boolean;
  operations: {
    start(owner?: string): string;
    finish(operationId: string): void;
    includes(operationId: string, owner?: string): boolean;
    active(owner?: string): string[];
    reset(owner?: string): void;
  };
  operationOwner?: string;
  presets(): readonly ModelPreset[];
  openPresetSettings?(): void;
  /** True while the chat is a deferred new session with no runtime yet. */
  deferredNewSession?(): boolean;
  /** The configuration the first prompt will carry (pending override or default preset). */
  effectiveConfiguration?(): ChatConfiguration | undefined;
  setPendingConfiguration?(configuration: ChatConfiguration): void | Promise<void>;
  setConfiguration(configuration: ChatConfiguration): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setFastMode(enabled: boolean): Promise<void>;
}

/** Reasoning configuration using runtime capabilities or the shared deferred catalog. */
export class ChatConfigurationStore extends Store<ChatConfigurationStoreProps> {
  error: string | undefined;
  errorDetails: string | undefined;
  private fastModeOverride: boolean | undefined;

  get catalog() {
    return ModelCatalogContext.consume(this)!;
  }
  get session() {
    return this.props.session();
  }
  get antigravityAvailable() {
    return this.props.antigravityAvailable?.() ?? false;
  }
  get fastMode() {
    return this.fastModeOverride ?? this.session?.fastMode ?? false;
  }
  get presets() {
    return this.props.presets();
  }
  get activePreset() {
    const id = this.deferred ? this.effectiveConfiguration?.preset?.id : this.session?.preset?.id;
    return this.presets.find((preset) => preset.id === id);
  }
  /** Offered after the presets; choosing it applies the configuration to this chat only. */
  get utilityModel() {
    return UtilityModelContext.consume(this)?.();
  }
  get activeOperations() {
    return this.props.operations.active(this.props.operationOwner);
  }

  @computed
  get modelsByProvider() {
    return this.groupModels(false);
  }

  @computed
  get connectedModelsByProvider() {
    return this.groupModels(true);
  }

  @computed
  private get runtimeModelOptions() {
    return this.session?.modelOptions;
  }

  private groupModels(connectedOnly: boolean) {
    const options = this.runtimeModelOptions;
    const models = options?.length ? options : this.catalog.models;
    const groups = new Map<
      string,
      { name: string; models: (ModelOption | RuntimeModelOption)[] }
    >();
    // Keep runtime references: search and configuration read labels and capabilities
    // separately, without making them dependencies of provider grouping.
    for (const model of models) {
      const runtime = model instanceof RuntimeModelOption;
      const provider = runtime
        ? connectedOnly
          ? model.connectedProvider
          : model.provider
        : connectedOnly && !model.authenticated
          ? undefined
          : model.provider;
      if (provider === undefined) continue;
      const group = groups.get(provider) ?? {
        name: runtime ? model.providerHeading : model.providerName,
        models: [],
      };
      group.models.push(model);
      groups.set(provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }

  get deferredModelName() {
    const selected = this.effectiveConfiguration;
    return this.deferred && selected
      ? this.catalog.models.find(
          (model) => model.provider === selected.provider && model.id === selected.modelId,
        )?.name
      : undefined;
  }

  get deferred() {
    return this.props.deferredNewSession?.() ?? false;
  }

  get effectiveConfiguration() {
    return this.props.effectiveConfiguration?.();
  }

  async selectModel(value: string) {
    const separator = value.indexOf("/");
    if (separator < 1) return;
    const provider = value.slice(0, separator);
    const modelId = value.slice(separator + 1);
    if (isAntigravityModel({ provider })) {
      await this.selectConfiguration({ provider, modelId, thinkingLevel: "off", fastMode: false });
      return;
    }
    // Deferred chats have no runtime. The owner persists saved Draft choices or
    // keeps unsaved choices locally for the first prompt.
    if (this.deferred) {
      const base = this.effectiveConfiguration;
      await this.writePendingConfiguration({
        thinkingLevel: base?.thinkingLevel ?? "off",
        fastMode: base?.fastMode ?? false,
        provider,
        modelId,
      });
      return;
    }
    await this.run(() => this.props.setModel(provider, modelId));
  }

  async selectConfiguration(configuration: ChatConfiguration) {
    if (this.deferred) {
      // Presets carry presentation fields; persist only the runtime contract.
      await this.writePendingConfiguration({
        provider: configuration.provider,
        modelId: configuration.modelId,
        thinkingLevel: configuration.thinkingLevel,
        fastMode: configuration.fastMode,
        ...(configuration.preset ? { preset: configuration.preset } : null),
      });
      return;
    }
    this.fastModeOverride = configuration.fastMode;
    const accepted = await this.run(() => this.props.setConfiguration(configuration));
    this.fastModeOverride = undefined;
    if (!accepted) return;
  }

  async selectPreset(preset: ModelPreset) {
    await this.selectConfiguration({
      ...preset,
      preset: {
        id: preset.id,
        ...(preset.promptFile === undefined ? null : { promptFile: preset.promptFile }),
      },
    });
  }

  get canOpenPresetSettings() {
    return Boolean(this.props.openPresetSettings);
  }

  openPresetSettings() {
    this.props.openPresetSettings?.();
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    if (this.deferred) {
      const base = this.effectiveConfiguration;
      if (base) await this.writePendingConfiguration({ ...base, thinkingLevel: level });
      return;
    }
    await this.run(() => this.props.setThinkingLevel(level));
  }

  async selectFastMode(enabled: boolean) {
    if (this.deferred) {
      const base = this.effectiveConfiguration;
      if (base) await this.writePendingConfiguration({ ...base, fastMode: enabled });
      return;
    }
    this.fastModeOverride = enabled;
    await this.run(() => this.props.setFastMode(enabled));
    this.fastModeOverride = undefined;
  }

  private writePendingConfiguration(configuration: ChatConfiguration) {
    return this.run(async () => {
      await this.props.setPendingConfiguration?.(configuration);
    });
  }

  private async run(command: () => Promise<void>) {
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.props.operations.start(this.props.operationOwner);
    try {
      await command();
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    } finally {
      this.finish(operationId);
    }
  }

  private finish(operationId: string) {
    this.props.operations.finish(operationId);
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
}
