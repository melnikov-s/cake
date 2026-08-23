import { Store, observable } from "r-state-tree";
import type { PiSettingUpdate } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { describeError } from "../error-details";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface ProviderSettingsStoreProps {
  client: Pick<DesktopClient, "setPiSetting" | "reloadPi" | "refreshModels" | "login" | "logout">;
  sessionContext(): { sessionId: string } | undefined;
  operations: SessionOperationCoordinatorStore;
}

/** Owns current-session Pi settings, model refresh, and provider authentication. */
export class ProviderSettingsStore extends Store<ProviderSettingsStoreProps> {
  readonly providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> =
    observable({});
  error: string | undefined;
  errorDetails: string | undefined;
  private refreshOperationId: string | undefined;
  private readonly ownedOperationIds = new Set<string>();

  constructor(props: ProviderSettingsStore["props"]) {
    super(props);
    this.effect(() => () => {
      for (const operationId of this.ownedOperationIds) this.props.operations.finish(operationId);
      this.ownedOperationIds.clear();
    });
  }

  get activeOperations() {
    return this.props.operations.active("settings");
  }
  get refreshingModels() {
    return Boolean(
      this.refreshOperationId && this.activeOperations.includes(this.refreshOperationId),
    );
  }

  async setPiSetting(update: PiSettingUpdate) {
    await this.run((operationId, sessionId) =>
      this.props.client.setPiSetting({ operationId, sessionId, update }),
    );
  }
  async reloadPi() {
    await this.run((operationId, sessionId) =>
      this.props.client.reloadPi({ operationId, sessionId }),
    );
  }
  async refreshModels() {
    if (this.refreshingModels || this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    this.refreshOperationId = operationId;
    try {
      await this.props.client.refreshModels({ operationId, sessionId: this.requireSessionId() });
    } catch (error) {
      if (this.signal.aborted) return;
      this.refreshOperationId = undefined;
      this.reportError(error);
      this.finish(operationId);
    }
  }
  async authenticate(provider: string, authType: "api_key" | "oauth") {
    if (this.providerOperation(provider) || this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    this.providerOperations[operationId] = { provider, kind: "login" };
    try {
      await this.props.client.login({
        operationId,
        sessionId: this.requireSessionId(),
        provider,
        authType,
      });
    } catch (error) {
      if (this.signal.aborted) return;
      delete this.providerOperations[operationId];
      this.reportError(error);
      this.finish(operationId);
    }
  }
  async logout(provider: string) {
    if (this.providerOperation(provider) || this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    this.providerOperations[operationId] = { provider, kind: "logout" };
    try {
      await this.props.client.logout({ operationId, sessionId: this.requireSessionId(), provider });
    } catch (error) {
      if (this.signal.aborted) return;
      delete this.providerOperations[operationId];
      this.reportError(error);
      this.finish(operationId);
    }
  }
  providerOperation(provider: string) {
    return Object.values(this.providerOperations).find(
      (operation) => operation.provider === provider,
    )?.kind;
  }
  receive(event: DesktopClientEvent) {
    if (event.type === "operation-completed" && this.ownedOperationIds.has(event.operationId)) {
      this.finishTrackedOperation(event.operationId);
      return;
    }
    if (
      event.type === "operation-failed" &&
      event.operationId &&
      this.ownedOperationIds.has(event.operationId)
    ) {
      this.finishTrackedOperation(event.operationId);
      this.reportError(event.message);
      return;
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      this.refreshOperationId = undefined;
      for (const operationId of this.ownedOperationIds) this.finishTrackedOperation(operationId);
    }
  }
  private finishTrackedOperation(operationId: string) {
    if (this.providerOperations[operationId]) delete this.providerOperations[operationId];
    if (this.refreshOperationId === operationId) this.refreshOperationId = undefined;
    this.finish(operationId);
  }
  private requireSessionId() {
    const context = this.props.sessionContext();
    if (!context) throw new Error("No active session");
    return context.sessionId;
  }
  private async run(command: (operationId: string, sessionId: string) => Promise<void>) {
    if (this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    try {
      await command(operationId, this.requireSessionId());
    } catch (error) {
      if (this.signal.aborted) return;
      this.reportError(error);
      this.finish(operationId);
    }
  }
  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }
  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
  private startOperation() {
    const operationId = this.props.operations.start("settings");
    this.ownedOperationIds.add(operationId);
    return operationId;
  }
  private finish(operationId: string) {
    this.ownedOperationIds.delete(operationId);
    this.props.operations.finish(operationId);
  }
}
