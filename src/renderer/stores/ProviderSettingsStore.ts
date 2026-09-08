import { Store, observable } from "r-state-tree";
import type { PiSettingUpdate } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { SettingsSessionContext } from "./context/SettingsSessionContext";
import { describeError } from "../lib/error-details";
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
    return ClientContext.consume(this)!;
  }

  get activeSession() {
    return SettingsSessionContext.consume(this);
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
    await this.run((target) =>
      target.kind === "project-session"
        ? this.client.projectSessions.setPiSetting(
            { sessionId: target.sessionId, update },
            { signal: this.signal },
          )
        : this.client.cakeChats.setPiSetting(
            { sessionId: target.sessionId, tools: target.tools, update },
            { signal: this.signal },
          ),
    );
  }

  async reloadPi() {
    await this.run((target) =>
      target.kind === "project-session"
        ? this.client.projectSessions.reload(
            { sessionId: target.sessionId },
            { signal: this.signal },
          )
        : this.client.cakeChats.reload(
            { sessionId: target.sessionId, tools: target.tools },
            { signal: this.signal },
          ),
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
      const target = this.requireSession();
      if (target.kind === "project-session")
        await this.client.projectSessions.login(
          { sessionId: target.sessionId, provider, authType },
          { signal: this.signal },
        );
      else
        await this.client.cakeChats.login(
          { sessionId: target.sessionId, tools: target.tools, provider, authType },
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
      const target = this.requireSession();
      if (target.kind === "project-session")
        await this.client.projectSessions.logout(
          { sessionId: target.sessionId, provider },
          { signal: this.signal },
        );
      else
        await this.client.cakeChats.logout(
          { sessionId: target.sessionId, tools: target.tools, provider },
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

  private requireSession() {
    const context = this.activeSession;
    if (!context) throw new Error("No active chat");
    return context;
  }

  private async run(command: (target: NonNullable<typeof this.activeSession>) => Promise<void>) {
    if (this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    try {
      await command(this.requireSession());
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
