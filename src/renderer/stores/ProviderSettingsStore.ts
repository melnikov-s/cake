import { Store, observable } from "r-state-tree";
import type { ModelOption, PiSettingUpdate, PiSettings } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface ProviderAuthNotice {
  readonly type: "info" | "progress" | "auth_url" | "device_code";
  readonly message?: string;
  readonly url?: string;
  readonly instructions?: string;
  readonly verificationUri?: string;
  readonly userCode?: string;
}

export interface ProviderSettingsStoreProps {
  operations: SessionOperationCoordinatorStore;
}

/** Owns current-session Pi settings, model refresh, and provider authentication. */
export class ProviderSettingsStore extends Store<ProviderSettingsStoreProps> {
  readonly providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> =
    observable({});
  readonly catalogModels: ModelOption[] = observable([]);
  /** Ephemeral, initiating-device presentation only; never persisted with Pi credentials. */
  readonly authNotices: Record<string, ProviderAuthNotice> = observable({});
  loadingModels = true;
  loadingSettings = true;
  piSettings: PiSettings | undefined;
  error: string | undefined;
  errorDetails: string | undefined;
  private catalogLoadRevision = 0;
  private hydration: Promise<void> | undefined;
  private refreshOperationId: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
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
    this.hydration ??= Promise.all([this.loadCatalog(), this.loadSettings()]).then(() => undefined);
    return this.hydration;
  }

  async setPiSetting(update: PiSettingUpdate) {
    await this.run(async () => {
      this.piSettings = await this.client.piSettings.update(update, { signal: this.signal });
    });
  }

  async reloadPi() {
    await this.run(async () => {
      this.piSettings = await this.client.piSettings.reload({ signal: this.signal });
    });
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

  receiveAuthNotice(event: { readonly provider: string; readonly notice: ProviderAuthNotice }) {
    if (!this.signal.aborted) this.authNotices[event.provider] = event.notice;
  }

  /** Auth dialogs use an operation scope, not the currently selected Pi session. */
  authNoticeForRequest(request: {
    sessionId: string;
    title: string;
  }): ProviderAuthNotice | undefined {
    if (!/^provider-settings:\d+:[^:]+$/.test(request.sessionId)) return undefined;
    return Object.entries(this.authNotices).find(
      ([provider]) => request.title === `Provider authentication · ${provider}`,
    )?.[1];
  }

  async openAuthUrl(url: string) {
    if (this.signal.aborted) return;
    try {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol))
        throw new Error("Invalid authentication URL");
      // A callback listener started by Pi is on the backend, not this device.
      if (
        parsed.hostname === "localhost" ||
        parsed.hostname.endsWith(".localhost") ||
        /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname) ||
        parsed.hostname === "[::1]"
      )
        throw new Error(
          "This callback belongs to the server. Paste the resulting code or redirect URL into the authentication form instead.",
        );
      await this.client.electron.openExternalUrl(url, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    if (this.providerOperation(provider) || this.signal.aborted) return;
    delete this.authNotices[provider];
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
    delete this.authNotices[provider];
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

  private async loadSettings() {
    try {
      const settings = await this.client.piSettings.get({ signal: this.signal });
      if (!this.signal.aborted) this.piSettings = settings;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    } finally {
      if (!this.signal.aborted) this.loadingSettings = false;
    }
  }

  private async run(command: () => Promise<void>) {
    if (this.signal.aborted) return;
    this.clearError();
    const operationId = this.startOperation();
    try {
      await command();
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
