import { Store, observable } from "r-state-tree";
import type { ApplicationState, PiSettingUpdate, ThinkingLevel, UtilityModel } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import { describeError } from "../error-details";

export interface SettingsStoreProps {
  client: Pick<DesktopClient, "setPiSetting" | "reloadPi" | "login" | "logout" | "setUtilityModel">;
  sessionContext(): { workspacePath: string; sessionId: string } | undefined;
  operations: SessionOperationCoordinator;
}

/** Owns model, reasoning, Pi preference, and provider-authentication workflows. */
export class SettingsStore extends Store<SettingsStoreProps> {
  theme: "system" | "light" | "dark" = "system";
  providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> = observable({});
  utilityModel: UtilityModel | undefined;
  utilityModelSaving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private utilitySaveRevision = 0;
  private utilitySaveQueue: Promise<unknown> = Promise.resolve();
  private persistedUtilityModel: UtilityModel | undefined;
  get activeOperations() { return this.props.operations.active("settings"); }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  setTheme(theme: "system" | "light" | "dark") {
    this.theme = theme;
  }

  applyApplicationState(state: ApplicationState) {
    this.persistedUtilityModel = state.utilityModel;
    this.utilityModel = state.utilityModel;
  }

  selectUtilityModel(value: string) {
    const separator = value.indexOf("/");
    if (separator < 1) return Promise.resolve();
    return this.saveUtilityModel({
      provider: value.slice(0, separator),
      modelId: value.slice(separator + 1),
      thinkingLevel: this.utilityModel?.thinkingLevel ?? "off"
    });
  }

  selectUtilityThinkingLevel(thinkingLevel: ThinkingLevel) {
    if (!this.utilityModel) return Promise.resolve();
    return this.saveUtilityModel({ ...this.utilityModel, thinkingLevel });
  }

  clearUtilityModel() {
    return this.saveUtilityModel(undefined);
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
    const operationId = this.props.operations.start("settings");
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
    const operationId = this.props.operations.start("settings");
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

  private saveUtilityModel(model: UtilityModel | undefined) {
    const revision = ++this.utilitySaveRevision;
    this.utilityModel = model;
    this.utilityModelSaving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.utilitySaveQueue
      .catch(() => undefined)
      .then(() => this.props.client.setUtilityModel(model))
      .then((state) => {
        this.persistedUtilityModel = state.utilityModel;
        if (revision === this.utilitySaveRevision) this.utilityModel = state.utilityModel;
      })
      .catch((error) => {
        if (revision === this.utilitySaveRevision) {
          this.utilityModel = this.persistedUtilityModel;
          this.reportError(error);
        }
      })
      .finally(() => {
        if (revision === this.utilitySaveRevision) this.utilityModelSaving = false;
      });
    this.utilitySaveQueue = save;
    return save;
  }

  private requireContext() {
    const context = this.props.sessionContext();
    if (!context) throw new Error("No active session");
    return context;
  }

  private async run(command: (operationId: string, context: { workspacePath: string; sessionId: string }) => Promise<void>) {
    this.error = undefined; this.errorDetails = undefined;
    const operationId = this.props.operations.start("settings");
    try {
      await command(operationId, this.requireContext());
    } catch (error) {
      this.reportError(error);
      this.finish(operationId);
    }
  }

  private finish(operationId: string) {
    this.props.operations.finish(operationId);
  }
}
