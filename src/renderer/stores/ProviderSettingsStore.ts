import { Store, observable } from "r-state-tree";
import type { PiSettingUpdate, PiSettings } from "../../contracts/conversations/session-contract";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { ModelCatalogContext } from "./context/ModelCatalogContext";
import type { PiExtensionSetting } from "../../contracts/pi/extension-settings-data";

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

/** Owns Pi settings requests and initiating-device provider authentication. */
export class ProviderSettingsStore extends Store<ProviderSettingsStoreProps> {
  readonly providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> =
    observable({});
  /** Ephemeral, initiating-device presentation only; never persisted with Pi credentials. */
  readonly authNotices: Record<string, ProviderAuthNotice> = observable({});
  loadingSettings = true;
  /** Pi is authority; this Store owns ephemeral settings-panel requests only. */
  readonly extensionSources: PiExtensionSetting[] = observable([]);
  extensionsLoading = false;
  extensionUpdateId: string | undefined;
  private extensionsLoaded = false;
  private extensionLoadRevision = 0;
  piSettings: PiSettings | undefined;
  error: string | undefined;
  errorDetails: string | undefined;
  private hydration: Promise<void> | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  get activeOperations() {
    return this.props.operations.active("settings");
  }
  get catalog() {
    return ModelCatalogContext.consume(this)!;
  }

  hydrate() {
    this.hydration ??= Promise.all([this.catalog.ensureLoaded(), this.loadSettings()]).then(
      () => undefined,
    );
    return this.hydration;
  }

  async setPiSetting(update: PiSettingUpdate) {
    await this.run(async () => {
      const value = await this.client.piSettings.update(update, { signal: this.signal });
      if (!this.signal.aborted) this.piSettings = value;
      if (this.extensionsLoaded && (update.key === "extensions" || update.key === "packages"))
        await this.loadExtensions();
    });
  }

  async loadExtensions() {
    if (this.extensionsLoading || this.signal.aborted) return;
    const revision = ++this.extensionLoadRevision;
    this.extensionsLoading = true;
    await this.run(async () => {
      const entries = await this.client.piSettings.extensions({ signal: this.signal });
      if (!this.signal.aborted && revision === this.extensionLoadRevision) {
        this.extensionSources.splice(0, this.extensionSources.length, ...entries);
        this.extensionsLoaded = true;
      }
    });
    if (!this.signal.aborted && revision === this.extensionLoadRevision)
      this.extensionsLoading = false;
  }

  async setExtensionEnabled(id: string, enabled: boolean) {
    if (this.extensionUpdateId || this.extensionsLoading || this.signal.aborted) return;
    this.extensionUpdateId = id;
    try {
      await this.run(async () => {
        const settings = await this.client.piSettings.setExtensionEnabled(
          { id, enabled },
          { signal: this.signal },
        );
        if (!this.signal.aborted) this.piSettings = settings;
        await this.loadExtensions();
      });
    } finally {
      if (!this.signal.aborted) this.extensionUpdateId = undefined;
    }
  }

  setCodemodeInlineBudget(value: string) {
    const budget = Number(value);
    if (value.trim() === "" || !Number.isSafeInteger(budget) || budget < 0 || budget > 100_000) {
      this.reportError(new Error("Codemode inline budget must be an integer from 0 to 100000."));
      return Promise.resolve();
    }
    return this.setPiSetting({ key: "codemodeInlineBudget", value: budget });
  }

  async reloadPi() {
    await this.run(async () => {
      this.piSettings = await this.client.piSettings.reload({ signal: this.signal });
      if (this.extensionsLoaded) await this.loadExtensions();
    });
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
      if (!this.signal.aborted) await this.catalog.reload();
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
      if (!this.signal.aborted) await this.catalog.reload();
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
