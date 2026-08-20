import { Store } from "r-state-tree";
import type { ModelOption, ThinkingLevel } from "../../ipc/session-contract";
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
  setModel(operationId: string, provider: string, modelId: string): Promise<void>;
  setThinkingLevel(operationId: string, level: ThinkingLevel): Promise<void>;
  setFastMode(operationId: string, enabled: boolean): Promise<void>;
}

/** Reusable model-catalog and reasoning configuration for one Pi chat session. */
export class ChatConfigurationStore extends Store<ChatConfigurationStoreProps> {
  error: string | undefined;
  errorDetails: string | undefined;
  private fastModeOverride: boolean | undefined;
  private fastModeOperationId: string | undefined;

  get session() {
    return this.props.session();
  }
  get fastMode() {
    return this.fastModeOverride ?? this.session?.fastMode ?? false;
  }
  get activeOperations() {
    return this.props.operations.active(this.props.operationOwner);
  }

  get modelsByProvider() {
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of this.session?.models ?? []) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }

  get connectedModelsByProvider() {
    return this.modelsByProvider
      .map((group) => ({ ...group, models: group.models.filter((model) => model.authenticated) }))
      .filter((group) => group.models.length > 0);
  }

  async selectModel(value: string) {
    const separator = value.indexOf("/");
    if (separator < 1) return;
    await this.run((operationId) =>
      this.props.setModel(operationId, value.slice(0, separator), value.slice(separator + 1)),
    );
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    await this.run((operationId) => this.props.setThinkingLevel(operationId, level));
  }

  async selectFastMode(enabled: boolean) {
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
      if (event.type === "operation-failed") this.reportError(event.message);
      this.finish(event.operationId);
      return;
    }
    if (
      (event.type === "global-chat-operation-completed" ||
        event.type === "global-chat-operation-failed") &&
      this.activeOperations.includes(event.operationId)
    ) {
      if (event.type === "global-chat-operation-failed") this.reportError(event.message);
      this.finish(event.operationId);
    }
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
