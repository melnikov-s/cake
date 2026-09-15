import { Store, observable } from "r-state-tree";
import type { ModelOption, PiSettingUpdate } from "../../ipc/session-contract";
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
  readonly catalogModels: ModelOption[] = observable([]);
  loadingModels = true;
  error: string | undefined;
  errorDetails: string | undefined;
  private catalogLoadRevision = 0;
  private hydration: Promise<void> | undefined;
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
  get modelsByProvider() {
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of this.catalogModels) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }
  get refreshingModels() {
    return Boolean(
      this.refreshOperationId && this.activeOperations.includes(this.refreshOperationId),
    );
  }

  hydrate() {
    this.hydration ??= this.loadCatalog();
    return this.hydration;
  }

  async setPiSetting(update: PiSettingUpdate) {
    await this.run((target) =>
      this.client.sessionChats.setPiSetting(
        { sessionId: target.sessionId, update },
        { signal: this.signal },
      ),
    );
  }

  async reloadPi() {
    await this.run((target) =>
      this.client.sessionChats.reload({ sessionId: target.sessionId }, { signal: this.signal }),
    );
  }

  async refreshModels() {
    if (this.refreshingModels || this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    this.refreshOperationId = operationId;
    try {
      await this.client.models.refresh({ signal: this.signal });
      await this.loadCatalog();
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
      await this.client.models.login({ provider, authType }, { signal: this.signal });
      await this.loadCatalog();
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
      await this.client.models.logout({ provider }, { signal: this.signal });
      await this.loadCatalog();
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

  private async loadCatalog() {
    const revision = ++this.catalogLoadRevision;
    try {
      const models = await this.client.models.list({ signal: this.signal });
      if (!this.signal.aborted && revision === this.catalogLoadRevision)
        this.catalogModels.splice(0, this.catalogModels.length, ...models);
    } catch (error) {
      if (!this.signal.aborted && revision === this.catalogLoadRevision) this.reportError(error);
    } finally {
      if (!this.signal.aborted && revision === this.catalogLoadRevision) this.loadingModels = false;
    }
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
