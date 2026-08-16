import { Store } from "r-state-tree";
import type { ModelOption, ThinkingLevel } from "../../ipc/session-contract";
import type { SessionModel } from "../models/session";
import type { DesktopClientEvent } from "../desktop-client";
import { describeError } from "../error-details";

export interface ChatConfigurationStoreProps {
  session(): SessionModel | undefined;
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
}

/** Reusable model-catalog and reasoning configuration for one Pi chat session. */
export class ChatConfigurationStore extends Store<ChatConfigurationStoreProps> {
  error: string | undefined;
  errorDetails: string | undefined;
  get session() { return this.props.session(); }
  get activeOperations() { return this.props.operations.active(this.props.operationOwner); }

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
    await this.run((operationId) => this.props.setModel(operationId, value.slice(0, separator), value.slice(separator + 1)));
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    await this.run((operationId) => this.props.setThinkingLevel(operationId, level));
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
      this.props.operations.reset(this.props.operationOwner);
      return;
    }
    if ((event.type === "operation-completed" || event.type === "operation-failed") && event.operationId && this.activeOperations.includes(event.operationId)) {
      if (event.type === "operation-failed") this.reportError(event.message);
      this.finish(event.operationId);
      return;
    }
    if ((event.type === "global-chat-operation-completed" || event.type === "global-chat-operation-failed") && this.activeOperations.includes(event.operationId)) {
      if (event.type === "global-chat-operation-failed") this.reportError(event.message);
      this.finish(event.operationId);
    }
  }

  private async run(command: (operationId: string) => Promise<void>) {
    this.error = undefined; this.errorDetails = undefined;
    const operationId = this.props.operations.start(this.props.operationOwner);
    try { await command(operationId); }
    catch (error) {
      this.reportError(error);
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
