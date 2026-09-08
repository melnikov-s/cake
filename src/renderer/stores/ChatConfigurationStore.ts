import { Store, observable } from "r-state-tree";
import type {
  ChatConfiguration,
  ModelOption,
  ModelPreset,
  ThinkingLevel,
} from "../../ipc/session-contract";
import type { Session } from "../models/Session";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

export interface ChatConfigurationStoreProps {
  session(): Session | undefined;
  operations: {
    start(owner?: string): string;
    finish(operationId: string): void;
    includes(operationId: string, owner?: string): boolean;
    active(owner?: string): string[];
    reset(owner?: string): void;
  };
  operationOwner?: string;
  presets(): readonly ModelPreset[];
  openPresetSettings(): void;
  /** True while the chat is a deferred new session with no runtime yet. */
  deferredNewSession?(): boolean;
  /** The configuration the first prompt will carry (pending override or default preset). */
  effectiveConfiguration?(): ChatConfiguration | undefined;
  setPendingConfiguration?(configuration: ChatConfiguration): void;
  setConfiguration(configuration: ChatConfiguration): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setFastMode(enabled: boolean): Promise<void>;
}

/** Reusable model-catalog and reasoning configuration for one Pi chat session. */
export class ChatConfigurationStore extends Store<ChatConfigurationStoreProps> {
  error: string | undefined;
  errorDetails: string | undefined;
  readonly catalogModels: ModelOption[] = observable([]);
  private catalogLoadRevision = 0;
  private fastModeOverride: boolean | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }
  get session() {
    return this.props.session();
  }
  get fastMode() {
    return this.fastModeOverride ?? this.session?.fastMode ?? false;
  }
  get presets() {
    return this.props.presets();
  }
  get activePreset() {
    const session = this.session;
    if (this.deferred || !session?.model) {
      const pending = this.effectiveConfiguration;
      if (!pending) return undefined;
      return this.presets.find(
        (preset) =>
          preset.provider === pending.provider &&
          preset.modelId === pending.modelId &&
          preset.thinkingLevel === pending.thinkingLevel &&
          preset.fastMode === pending.fastMode,
      );
    }
    return this.presets.find(
      (preset) =>
        preset.provider === session.model?.provider &&
        preset.modelId === session.model.modelId &&
        preset.thinkingLevel === session.thinkingLevel &&
        preset.fastMode === this.fastMode,
    );
  }
  get activeOperations() {
    return this.props.operations.active(this.props.operationOwner);
  }

  get modelsByProvider() {
    // A runtime-backed session carries its own authoritative catalog; a
    // deferred chat falls back to the shared agent-directory catalog.
    const models = this.session?.modelOptions.length
      ? this.session.modelOptions.map((option) => option.value)
      : this.catalogModels;
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of models) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }

  /**
   * Loads the session-less catalog for deferred chats with no runtime. Refetches
   * on every picker open so a model refresh surfaces immediately; the shared
   * agent-directory catalog is held in memory by the main process and costs no
   * network round trip.
   */
  ensureCatalog() {
    if (!this.deferred) return;
    const revision = ++this.catalogLoadRevision;
    void this.client.models
      .list({ signal: this.signal })
      .then((models) => {
        if (!this.signal.aborted && revision === this.catalogLoadRevision)
          this.catalogModels.splice(0, this.catalogModels.length, ...models);
      })
      .catch(() => undefined);
  }

  get connectedModelsByProvider() {
    return this.modelsByProvider
      .map((group) => ({ ...group, models: group.models.filter((model) => model.authenticated) }))
      .filter((group) => group.models.length > 0);
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
    // A deferred new session has no runtime; keep the choice locally so the
    // first prompt carries it instead of failing to resolve an unknown session.
    if (this.deferred) {
      this.writePendingConfiguration({
        ...(this.effectiveConfiguration ?? { thinkingLevel: "off", fastMode: false }),
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
      this.writePendingConfiguration({
        provider: configuration.provider,
        modelId: configuration.modelId,
        thinkingLevel: configuration.thinkingLevel,
        fastMode: configuration.fastMode,
      });
      return;
    }
    this.fastModeOverride = configuration.fastMode;
    const accepted = await this.run(() => this.props.setConfiguration(configuration));
    this.fastModeOverride = undefined;
    if (!accepted) return;
  }

  async selectPreset(preset: ModelPreset) {
    await this.selectConfiguration(preset);
  }

  openPresetSettings() {
    this.props.openPresetSettings();
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    if (this.deferred) {
      const base = this.effectiveConfiguration;
      if (base) this.writePendingConfiguration({ ...base, thinkingLevel: level });
      return;
    }
    await this.run(() => this.props.setThinkingLevel(level));
  }

  async selectFastMode(enabled: boolean) {
    if (this.deferred) {
      const base = this.effectiveConfiguration;
      if (base) this.writePendingConfiguration({ ...base, fastMode: enabled });
      return;
    }
    this.fastModeOverride = enabled;
    await this.run(() => this.props.setFastMode(enabled));
    this.fastModeOverride = undefined;
  }

  private writePendingConfiguration(configuration: ChatConfiguration) {
    this.error = undefined;
    this.errorDetails = undefined;
    this.props.setPendingConfiguration?.(configuration);
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
