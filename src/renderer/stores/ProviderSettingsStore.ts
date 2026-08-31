import { Store, observable } from "r-state-tree";
import type { PiSettingUpdate } from "../../ipc/session-contract";
import { RendererClientContext } from "../client/RendererClientContext";
import { ActiveProjectSessionContext } from "../context/ActiveProjectSessionContext";
import { describeError } from "../error-details";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface ProviderSettingsStoreProps {
  operations: SessionOperationCoordinatorStore;
}

/** Owns current-session Pi settings, model refresh, and provider authentication. */
export class ProviderSettingsStore extends Store<ProviderSettingsStoreProps> {
  readonly providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> =
    observable({});
  error: string | undefined;
  errorDetails: string | undefined;
  private refreshOperationId: string | undefined;

  get client() {
    return RendererClientContext.consume(this)!;
  }

  get activeSession() {
    return ActiveProjectSessionContext.consume(this);
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
    await this.run((sessionId) =>
      this.client.projectSessions.setPiSetting({ sessionId, update }, { signal: this.signal }),
    );
  }

  async reloadPi() {
    await this.run((sessionId) =>
      this.client.projectSessions.reload({ sessionId }, { signal: this.signal }),
    );
  }

  async refreshModels() {
    if (this.refreshingModels || this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    this.refreshOperationId = operationId;
    try {
      await this.client.models.refresh({ signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    } finally {
      this.refreshOperationId = undefined;
      this.finish(operationId);
    }
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    if (this.providerOperation(provider) || this.signal.aborted) return;
    const operationId = this.startOperation();
    this.providerOperations[operationId] = { provider, kind: "login" };
    try {
      await this.client.projectSessions.login(
        { sessionId: this.requireSessionId(), provider, authType },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    } finally {
      delete this.providerOperations[operationId];
      this.finish(operationId);
    }
  }

  async logout(provider: string) {
    if (this.providerOperation(provider) || this.signal.aborted) return;
    const operationId = this.startOperation();
    this.providerOperations[operationId] = { provider, kind: "logout" };
    try {
      await this.client.projectSessions.logout(
        { sessionId: this.requireSessionId(), provider },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    } finally {
      delete this.providerOperations[operationId];
      this.finish(operationId);
    }
  }

  providerOperation(provider: string) {
    return Object.values(this.providerOperations).find(
      (operation) => operation.provider === provider,
    )?.kind;
  }

  private requireSessionId() {
    const context = this.activeSession;
    if (!context) throw new Error("No active Project Session");
    return context.sessionId;
  }

  private async run(command: (sessionId: string) => Promise<void>) {
    if (this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    try {
      await command(this.requireSessionId());
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    } finally {
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
    return this.props.operations.start("settings");
  }
  private finish(operationId: string) {
    this.props.operations.finish(operationId);
  }
}
