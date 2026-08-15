import { Store, observable } from "r-state-tree";
import type { ExtensionUiEvent, ExtensionUiState, ResourceDiagnostic } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { describeError } from "../error-details";

export interface UiRequestState {
  operationId: string;
  uiRequestId: string;
  kind: "confirm" | "text" | "secret" | "select" | "manual_code" | "editor";
  title: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  options?: Array<{ id: string; label: string }>;
}

export interface ExtensionNotification {
  id: string;
  message: string;
  tone: "info" | "warning" | "error";
}

export interface ExtensionUiStoreProps {
  client: Pick<DesktopClient, "respondToUi">;
  activeSessionId(): string | undefined;
  sessionContext(): { workspacePath: string; sessionId: string } | undefined;
  operationActive(operationId: string): boolean;
  setDraft(value: string | ((current: string) => string)): void;
  requestComposerFocus(): void;
}

/** Owns extension-provided dialogs and transient renderer presentation. */
export class ExtensionUiStore extends Store<ExtensionUiStoreProps> {
  request: UiRequestState | undefined;
  title: string | undefined;
  statuses: ExtensionUiState["statuses"] = observable([]);
  notifications: ExtensionNotification[] = observable([]);
  compatibilityDiagnostics: ResourceDiagnostic[] = observable([]);
  error: string | undefined;
  errorDetails: string | undefined;

  async respond(value?: string, cancelled = false) {
    const request = this.request;
    if (!request) return;
    this.error = undefined; this.errorDetails = undefined;
    this.request = undefined;
    this.props.requestComposerFocus();
    try {
      const context = this.props.sessionContext();
      if (!context) throw new Error("No active session");
      await this.props.client.respondToUi({ operationId: request.operationId, ...context, uiRequestId: request.uiRequestId, value, cancelled });
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  dismissNotification(id: string) {
    const index = this.notifications.findIndex((item) => item.id === id);
    if (index >= 0) this.notifications.splice(index, 1);
  }

  clear() {
    this.request = undefined;
    this.title = undefined;
    this.statuses.splice(0);
    this.notifications.splice(0);
    this.compatibilityDiagnostics.splice(0);
  }

  applyState(state: ExtensionUiState) {
    this.title = state.title;
    this.statuses.splice(0, this.statuses.length, ...state.statuses);
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "extension-ui-received") {
      if (event.sessionId === this.props.activeSessionId()) this.receiveExtensionEvent(event.event);
      return;
    }
    if (event.type === "ui-requested") {
      if (this.props.operationActive(event.operationId)) this.request = event;
      return;
    }
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) this.request = undefined;
  }

  private receiveExtensionEvent(event: ExtensionUiEvent) {
    if (event.kind === "notify") {
      this.notifications.push(event);
      if (this.notifications.length > 8) this.notifications.splice(0, this.notifications.length - 8);
      return;
    }
    if (event.kind === "status") {
      const index = this.statuses.findIndex((item) => item.key === event.key);
      if (event.text === undefined) { if (index >= 0) this.statuses.splice(index, 1); }
      else if (index >= 0) this.statuses.splice(index, 1, { key: event.key, text: event.text });
      else this.statuses.push({ key: event.key, text: event.text });
      return;
    }
    if (event.kind === "title") { this.title = event.title; return; }
    if (event.kind === "editor-text") {
      this.props.setDraft(event.mode === "insert" ? (current) => `${current}${event.text}` : event.text);
      this.props.requestComposerFocus();
      return;
    }
    if (!this.compatibilityDiagnostics.some((item) => item.id === event.diagnostic.id)) this.compatibilityDiagnostics.push(event.diagnostic);
  }
}
