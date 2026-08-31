import { Store, observable } from "r-state-tree";
import type { ResourceDiagnostic } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
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
  options?: Array<{ id: string; label: string }>;
}

export interface ExtensionNotification {
  id: string;
  message: string;
  tone: "info" | "warning" | "error";
}

export interface ExtensionUiStoreProps {
  client: Pick<DesktopClient, "respondToUi">;
  activeSessionModel(): Session | undefined;
  sessionContext(): { sessionId: string } | undefined;
  operationActive(operationId: string): boolean;
  setDraft(value: string | ((current: string) => string)): void;
  requestComposerFocus(): void;
}

/** Owns extension-provided dialogs and transient renderer presentation. */
export class ExtensionUiStore extends Store<ExtensionUiStoreProps> {
  request: UiRequestState | undefined;
  private readonly dismissedNotificationIds: Set<string> = observable(new Set<string>());
  error: string | undefined;
  errorDetails: string | undefined;

  constructor(props: ExtensionUiStore["props"]) {
    super(props);
    this.reaction(
      () => {
        const model = this.props.activeSessionModel();
        return model ? `${model.sessionId}\u0000${model.extensionUi.editorTextRevision}` : "";
      },
      (current, previous) => {
        const separator = current.lastIndexOf("\u0000");
        const previousSeparator = previous.lastIndexOf("\u0000");
        if (
          separator < 0 ||
          previousSeparator < 0 ||
          current.slice(0, separator) !== previous.slice(0, previousSeparator)
        )
          return;
        const event = this.props.activeSessionModel()?.extensionUi.editorText;
        if (!event) return;
        this.props.setDraft(
          event.mode === "insert" ? (draft) => `${draft}${event.text}` : event.text,
        );
        this.props.requestComposerFocus();
      },
    );
  }

  get title() {
    return this.props.activeSessionModel()?.extensionUi.title;
  }

  get statuses() {
    return this.props.activeSessionModel()?.extensionUi.statuses ?? [];
  }

  get notifications(): readonly ExtensionNotification[] {
    return (
      this.props
        .activeSessionModel()
        ?.extensionUi.notifications.filter(
          (notification) => !this.dismissedNotificationIds.has(notification.id),
        ) ?? []
    );
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
      await this.props.client.respondToUi({
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
    this.dismissedNotificationIds.add(id);
  }

  clear() {
    this.request = undefined;
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "ui-requested") {
      if (this.props.operationActive(event.operationId)) this.request = event;
      return;
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    )
      this.request = undefined;
  }
}
