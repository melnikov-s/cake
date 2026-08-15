import { Store, observable } from "r-state-tree";
import type { PiSettingUpdate } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import { describeError } from "../error-details";

export interface SettingsStoreProps {
  client: Pick<DesktopClient, "setPiSetting" | "reloadPi" | "login" | "logout">;
  sessionContext(): { workspacePath: string; sessionId: string } | undefined;
  operations: SessionOperationCoordinator;
}

/** Owns model, reasoning, Pi preference, and provider-authentication workflows. */
export class SettingsStore extends Store<SettingsStoreProps> {
  theme: "system" | "light" | "dark" = "system";
  providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> = observable({});
  readonly activeOperations: string[] = observable([]);
  error: string | undefined;
  errorDetails: string | undefined;

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  setTheme(theme: "system" | "light" | "dark") {
    this.theme = theme;
  }

  async setPiSetting(update: PiSettingUpdate) {
    await this.run((operationId, context) => this.props.client.setPiSetting({ operationId, ...context, update }));
  }

  async reloadPi() {
    await this.run((operationId, context) => this.props.client.reloadPi({ operationId, ...context }));
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    if (this.providerOperation(provider)) return;
    this.error = undefined; this.errorDetails = undefined;
    const operationId = this.props.operations.start();
    this.activeOperations.push(operationId);
    this.providerOperations[operationId] = { provider, kind: "login" };
    try {
      const context = this.requireContext();
      await this.props.client.login({ operationId, ...context, provider, authType });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.reportError(error);
      this.finish(operationId);
    }
  }

  async logout(provider: string) {
    if (this.providerOperation(provider)) return;
    this.error = undefined; this.errorDetails = undefined;
    const operationId = this.props.operations.start();
    this.activeOperations.push(operationId);
    this.providerOperations[operationId] = { provider, kind: "logout" };
    try {
      const context = this.requireContext();
      await this.props.client.logout({ operationId, ...context, provider });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.reportError(error);
      this.finish(operationId);
    }
  }

  providerOperation(provider: string) {
    return Object.values(this.providerOperations).find((operation) => operation.provider === provider)?.kind;
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "operation-completed" && this.activeOperations.includes(event.operationId)) {
      if (this.providerOperations[event.operationId]) delete this.providerOperations[event.operationId];
      this.finish(event.operationId);
    }
    if (event.type === "operation-failed" && event.operationId && this.activeOperations.includes(event.operationId)) {
      if (this.providerOperations[event.operationId]) delete this.providerOperations[event.operationId];
      this.finish(event.operationId);
      this.reportError(event.message);
    }
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
      for (const operationId of this.activeOperations.slice()) {
        if (this.providerOperations[operationId]) delete this.providerOperations[operationId];
        this.finish(operationId);
      }
    }
  }

  private requireContext() {
    const context = this.props.sessionContext();
    if (!context) throw new Error("No active session");
    return context;
  }

  private async run(command: (operationId: string, context: { workspacePath: string; sessionId: string }) => Promise<void>) {
    this.error = undefined; this.errorDetails = undefined;
    const operationId = this.props.operations.start();
    this.activeOperations.push(operationId);
    try {
      await command(operationId, this.requireContext());
    } catch (error) {
      this.reportError(error);
      this.finish(operationId);
    }
  }

  private finish(operationId: string) {
    const index = this.activeOperations.indexOf(operationId);
    if (index >= 0) this.activeOperations.splice(index, 1);
    this.props.operations.finish(operationId);
  }
}
