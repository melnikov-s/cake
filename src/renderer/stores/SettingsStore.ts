import { Store, observable } from "r-state-tree";
import type { ModelOption, PiSettingUpdate, ThinkingLevel } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionModel } from "../models/session";

export interface SettingsStoreProps {
  client: DesktopClient;
  session(): SessionModel | undefined;
  sessionContext(): { workspacePath: string; sessionId: string } | undefined;
  startOperation(): string;
  finishOperation(operationId: string): void;
  reportError(error: unknown): void;
}

/** Owns model, reasoning, Pi preference, and provider-authentication workflows. */
export class SettingsStore extends Store<SettingsStoreProps> {
  theme: "system" | "light" | "dark" = "system";
  providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> = observable({});

  get modelsByProvider() {
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of this.props.session()?.models ?? []) {
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

  setTheme(theme: "system" | "light" | "dark") {
    this.theme = theme;
  }

  async selectModel(value: string) {
    const separator = value.indexOf("/");
    if (separator < 1) return;
    await this.run((operationId, context) => this.props.client.setModel({ operationId, ...context, provider: value.slice(0, separator), modelId: value.slice(separator + 1) }));
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    await this.run((operationId, context) => this.props.client.setThinkingLevel({ operationId, ...context, level }));
  }

  async setPiSetting(update: PiSettingUpdate) {
    await this.run((operationId, context) => this.props.client.setPiSetting({ operationId, ...context, update }));
  }

  async reloadPi() {
    await this.run((operationId, context) => this.props.client.reloadPi({ operationId, ...context }));
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    if (this.providerOperation(provider)) return;
    const operationId = this.props.startOperation();
    this.providerOperations[operationId] = { provider, kind: "login" };
    try {
      const context = this.requireContext();
      await this.props.client.login({ operationId, ...context, provider, authType });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.props.reportError(error);
      this.props.finishOperation(operationId);
    }
  }

  async logout(provider: string) {
    if (this.providerOperation(provider)) return;
    const operationId = this.props.startOperation();
    this.providerOperations[operationId] = { provider, kind: "logout" };
    try {
      const context = this.requireContext();
      await this.props.client.logout({ operationId, ...context, provider });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.props.reportError(error);
      this.props.finishOperation(operationId);
    }
  }

  providerOperation(provider: string) {
    return Object.values(this.providerOperations).find((operation) => operation.provider === provider)?.kind;
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "operation-completed") delete this.providerOperations[event.operationId];
    if (event.type === "operation-failed" && event.operationId) delete this.providerOperations[event.operationId];
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
      for (const operationId of Object.keys(this.providerOperations)) delete this.providerOperations[operationId];
    }
  }

  private requireContext() {
    const context = this.props.sessionContext();
    if (!context) throw new Error("No active session");
    return context;
  }

  private async run(command: (operationId: string, context: { workspacePath: string; sessionId: string }) => Promise<void>) {
    const operationId = this.props.startOperation();
    try {
      await command(operationId, this.requireContext());
    } catch (error) {
      this.props.reportError(error);
      this.props.finishOperation(operationId);
    }
  }
}
