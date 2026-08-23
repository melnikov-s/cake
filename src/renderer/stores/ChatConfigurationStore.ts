import { Store, observable } from "r-state-tree";
import type {
  ChatConfiguration,
  ModelOption,
  ModelPreset,
  ThinkingLevel,
} from "../../ipc/session-contract";
import type { Session } from "../../models/Session";
import type { DesktopClientEvent } from "../desktop-client";
import { describeError } from "../error-details";

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
  /** Session-less model catalog for deferred chats that have no runtime snapshot. */
  listModels?(): Promise<ModelOption[]>;
  setConfiguration(operationId: string, configuration: ChatConfiguration): Promise<void>;
  setModel(operationId: string, provider: string, modelId: string): Promise<void>;
  setThinkingLevel(operationId: string, level: ThinkingLevel): Promise<void>;
  setFastMode(operationId: string, enabled: boolean): Promise<void>;
}

/** Reusable model-catalog and reasoning configuration for one Pi chat session. */
export class ChatConfigurationStore extends Store<ChatConfigurationStoreProps> {
  error: string | undefined;
  errorDetails: string | undefined;
  readonly catalogModels: ModelOption[] = observable([]);
  private catalogLoadRevision = 0;
  private fastModeOverride: boolean | undefined;
  private fastModeOperationId: string | undefined;

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
    if (!session?.model) {
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
        preset.modelId === session.model.id &&
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
    const models = this.session?.models.length ? this.session.models : this.catalogModels;
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of models) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }

  /** Loads the session-less catalog once for deferred chats with no runtime. */
  ensureCatalog() {
    if (!this.deferred || this.catalogModels.length > 0) return;
    if (!this.props.listModels) return;
    const revision = ++this.catalogLoadRevision;
    void this.props
      .listModels()
      .then((models) => {
        if (revision === this.catalogLoadRevision)
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
    await this.run((operationId) => this.props.setModel(operationId, provider, modelId));
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
    const accepted = await this.run((operationId) => {
      this.fastModeOperationId = operationId;
      return this.props.setConfiguration(operationId, configuration);
    });
    if (!accepted) {
      this.fastModeOverride = undefined;
      this.fastModeOperationId = undefined;
    }
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
    await this.run((operationId) => this.props.setThinkingLevel(operationId, level));
  }

  async selectFastMode(enabled: boolean) {
    if (this.deferred) {
      const base = this.effectiveConfiguration;
      if (base) this.writePendingConfiguration({ ...base, fastMode: enabled });
      return;
    }
    if (this.fastModeOperationId) return;
    this.fastModeOverride = enabled;
    const accepted = await this.run((operationId) => {
      this.fastModeOperationId = operationId;
      return this.props.setFastMode(operationId, enabled);
    });
    if (!accepted) {
      this.fastModeOverride = undefined;
      this.fastModeOperationId = undefined;
    }
  }

  receive(event: DesktopClientEvent) {
    if (
      event.type === "session-snapshot-received" ||
      event.type === "global-chat-snapshot-received"
    ) {
      if (
        event.snapshot.sessionId === this.session?.sessionId &&
        this.fastModeOverride !== undefined &&
        (event.snapshot.fastMode === this.fastModeOverride ||
          event.snapshot.fastModeAvailable === false)
      ) {
        this.fastModeOverride = undefined;
      }
    }
    if (
      (event.type === "operation-completed" || event.type === "operation-failed") &&
      event.operationId &&
      event.operationId === this.fastModeOperationId
    ) {
      this.fastModeOverride = undefined;
      this.fastModeOperationId = undefined;
    }
    if (
      (event.type === "global-chat-operation-completed" ||
        event.type === "global-chat-operation-failed") &&
      event.operationId === this.fastModeOperationId
    ) {
      this.fastModeOverride = undefined;
      this.fastModeOperationId = undefined;
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      this.fastModeOverride = undefined;
      this.fastModeOperationId = undefined;
      this.props.operations.reset(this.props.operationOwner);
      return;
    }
    if (
      (event.type === "operation-completed" || event.type === "operation-failed") &&
      event.operationId &&
      this.activeOperations.includes(event.operationId)
    ) {
      if (event.type === "operation-failed") {
        this.error = event.message;
        this.errorDetails = event.details ?? event.message;
      }
      this.finish(event.operationId);
      return;
    }
    if (
      (event.type === "global-chat-operation-completed" ||
        event.type === "global-chat-operation-failed") &&
      this.activeOperations.includes(event.operationId)
    ) {
      if (event.type === "global-chat-operation-failed") {
        this.error = event.message;
        this.errorDetails = event.details ?? event.message;
      }
      this.finish(event.operationId);
    }
  }

  private writePendingConfiguration(configuration: ChatConfiguration) {
    this.error = undefined;
    this.errorDetails = undefined;
    this.props.setPendingConfiguration?.(configuration);
  }

  private async run(command: (operationId: string) => Promise<void>) {
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.props.operations.start(this.props.operationOwner);
    try {
      await command(operationId);
      return true;
    } catch (error) {
      this.reportError(error);
      this.finish(operationId);
      return false;
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
