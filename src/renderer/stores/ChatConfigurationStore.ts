import { Store } from "r-state-tree";
import type { ModelOption, ThinkingLevel } from "../../ipc/session-contract";
import type { SessionModel } from "../models/session";

export interface ChatConfigurationStoreProps {
  session(): SessionModel | undefined;
  startOperation(): string;
  setModel(operationId: string, provider: string, modelId: string): Promise<void>;
  setThinkingLevel(operationId: string, level: ThinkingLevel): Promise<void>;
  finishOperation(operationId: string): void;
  reportError(error: unknown): void;
}

/** Reusable model-catalog and reasoning configuration for one Pi chat session. */
export class ChatConfigurationStore extends Store<ChatConfigurationStoreProps> {
  get session() { return this.props.session(); }

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

  private async run(command: (operationId: string) => Promise<void>) {
    const operationId = this.props.startOperation();
    try { await command(operationId); }
    catch (error) {
      this.props.reportError(error);
      this.props.finishOperation(operationId);
    }
  }
}
