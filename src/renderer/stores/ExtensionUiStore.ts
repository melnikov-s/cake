import { Store, observable } from "r-state-tree";
import type { ResourceDiagnostic } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import type { StoreEvent } from "../events/StoreEvent";
import type { Session } from "../models/Session";
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
  options?: ReadonlyArray<{ id: string; label: string }>;
}

export interface ExtensionNotification {
  id: string;
  message: string;
  tone: "info" | "warning" | "error";
}

export interface ExtensionUiStoreProps {
  activeSessionModel(): Session | undefined;
  sessionContext(): { sessionId: string } | undefined;
  setDraft(value: string | ((current: string) => string)): void;
  requestComposerFocus(): void;
}

/** Owns extension-provided dialogs and transient renderer presentation. */
export class ExtensionUiStore extends Store<ExtensionUiStoreProps> {
  get artifacts() {
    return ClientContext.consume(this)!.artifacts;
  }

  request: UiRequestState | undefined;
  readonly notifications: ExtensionNotification[] = observable([]);
  error: string | undefined;
  errorDetails: string | undefined;

  get title() {
    return this.props.activeSessionModel()?.extensionUi.title;
  }

  get statuses() {
    return this.props.activeSessionModel()?.extensionUi.statuses ?? [];
  }

  get compatibilityDiagnostics(): readonly ResourceDiagnostic[] {
    return this.props.activeSessionModel()?.extensionUi.compatibilityDiagnostics ?? [];
  }

  async respond(value?: string, cancelled = false) {
    const request = this.request;
    if (!request) return;
    this.error = undefined;
    this.errorDetails = undefined;
    this.request = undefined;
    this.props.requestComposerFocus();
    try {
      const context = this.props.sessionContext();
      if (!context) throw new Error("No active session");
      await this.artifacts.respondToUi({
        operationId: request.operationId,
        sessionId: context.sessionId,
        uiRequestId: request.uiRequestId,
        value,
        cancelled,
      });
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  dismissNotification(id: string) {
    const index = this.notifications.findIndex((notification) => notification.id === id);
    if (index >= 0) this.notifications.splice(index, 1);
  }

  clear() {
    this.request = undefined;
    this.notifications.splice(0);
  }

  receive(event: StoreEvent) {
    if (event.type === "extension-ui-intent") {
      if (event.sessionId !== this.props.sessionContext()?.sessionId) return;
      const intent = event.intent;
      if (intent.kind === "notify") {
        const index = this.notifications.findIndex((notification) => notification.id === intent.id);
        if (index >= 0) this.notifications.splice(index, 1);
        this.notifications.push(intent);
        if (this.notifications.length > 8)
          this.notifications.splice(0, this.notifications.length - 8);
        return;
      }
      this.props.setDraft(
        intent.mode === "insert" ? (draft) => `${draft}${intent.text}` : intent.text,
      );
      this.props.requestComposerFocus();
      return;
    }
    if (event.type === "ui-requested") {
      this.request = event;
      return;
    }
    if (event.type === "agent-availability-changed" && event.availability.state === "unavailable")
      this.request = undefined;
  }
}
