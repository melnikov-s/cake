import { Store, observable } from "r-state-tree";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { ResourceDiagnostic } from "../../contracts/conversations/session-contract";
import { ClientContext } from "./context/ClientContext";
import type { StoreEvent } from "../events/StoreEvent";
import type { Conversation } from "../models/Conversation";
import { describeError } from "../lib/error-details";
import { TOAST_TIMEOUT_MS, ToastExpiry } from "./toast-expiry";

export interface UiRequestState {
  operationId: string;
  uiRequestId: string;
  sessionId: string;
  kind: "confirm" | "text" | "secret" | "select" | "manual_code" | "editor";
  title: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  options?: ReadonlyArray<{ id: string; label: string }>;
}

type UiRequestIdentity = Pick<UiRequestState, "operationId" | "sessionId" | "uiRequestId">;

function sameRequest(request: UiRequestIdentity | undefined, identity: UiRequestIdentity) {
  return (
    request !== undefined &&
    request.operationId === identity.operationId &&
    request.sessionId === identity.sessionId &&
    request.uiRequestId === identity.uiRequestId
  );
}

export interface ExtensionNotification {
  id: string;
  message: string;
  tone: "info" | "warning" | "error";
}

export interface ExtensionUiStoreProps {
  activeSessionModel(): Conversation | undefined;
  /** The conversation whose extension notices this window presents. */
  noticeSessionId(): string | undefined;
  setDraft(value: string | ((current: string) => string)): void;
  requestComposerFocus(): void;
}

/** Owns extension-provided dialogs and transient renderer presentation. */
export class ExtensionUiStore extends Store<ExtensionUiStoreProps> {
  get client() {
    return ClientContext.consume(this)!;
  }

  get artifacts() {
    return this.client.artifacts;
  }

  private readonly requests = observable<UiRequestState[]>([]);

  get request() {
    return this.requests[0];
  }
  readonly notifications: ExtensionNotification[] = observable([]);
  private readonly notificationExpiry = new ToastExpiry();
  error: string | undefined;
  errorDetails: string | undefined;

  constructor(props: ExtensionUiStore["props"]) {
    super(props);
    this.effect(() => () => this.notificationExpiry.clear());
  }

  get title() {
    return this.props.activeSessionModel()?.extensionUi.title;
  }

  get statuses() {
    return this.props.activeSessionModel()?.extensionUi.statuses ?? [];
  }

  get compatibilityDiagnostics(): readonly ResourceDiagnostic[] {
    return this.props.activeSessionModel()?.extensionUi.compatibilityDiagnostics ?? [];
  }

  async respond(request: UiRequestIdentity, value?: string, cancelled = false) {
    // A callback can outlive the dialog that rendered it. Never apply its
    // value (including Cancel) to a different request, even in the same chat.
    if (this.signal.aborted || !sameRequest(this.request, request)) return;
    this.error = undefined;
    this.errorDetails = undefined;
    this.requests.shift();
    if (!this.request) this.props.requestComposerFocus();
    try {
      await this.artifacts.respondToUi({
        operationId: request.operationId,
        sessionId: request.sessionId,
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

  async dispatchCompanionAction(
    target: { sessionId: string; workingDirectory: string },
    companionId: string,
    action: string,
    value: JsonValue,
  ) {
    await this.client.projectSessions.dispatchExtensionCompanionAction({
      sessionId: target.sessionId,
      workingDirectory: target.workingDirectory,
      companionId,
      action,
      value,
    });
  }

  setToastPaused(id: string, paused: boolean) {
    this.notificationExpiry.setPaused(id, paused);
  }

  dismissNotification(id: string) {
    this.notificationExpiry.remove(id);
    const index = this.notifications.findIndex((notification) => notification.id === id);
    if (index >= 0) this.notifications.splice(index, 1);
  }

  clear() {
    this.requests.splice(0);
    this.notificationExpiry.clear();
    this.notifications.splice(0);
  }

  receive(event: StoreEvent) {
    if (this.signal.aborted) return;
    if (event.type === "extension-ui-intent") {
      if (event.sessionId !== this.props.noticeSessionId()) return;
      const intent = event.intent;
      if (intent.kind === "notify") {
        const index = this.notifications.findIndex((notification) => notification.id === intent.id);
        if (index >= 0) this.notifications.splice(index, 1);
        this.notifications.push(intent);
        if (this.notifications.length > 8) this.dismissNotification(this.notifications[0]!.id);
        this.notificationExpiry.start(intent.id, TOAST_TIMEOUT_MS, () =>
          this.dismissNotification(intent.id),
        );
        return;
      }
      this.props.setDraft(
        intent.mode === "insert" ? (draft) => `${draft}${intent.text}` : intent.text,
      );
      this.props.requestComposerFocus();
      return;
    }
    if (event.type === "ui-request-settled") {
      const index = this.requests.findIndex((request) =>
        sameRequest(request, {
          operationId: event.requestId,
          uiRequestId: event.uiRequestId,
          sessionId: event.sessionId,
        }),
      );
      if (index >= 0) {
        this.requests.splice(index, 1);
        if (!this.request) this.props.requestComposerFocus();
      }
      return;
    }
    if (event.type === "ui-requested") {
      // Keep the open dialog stable while other requests arrive.
      if (!this.requests.some((request) => sameRequest(request, event))) this.requests.push(event);
      return;
    }
    if (event.type === "agent-availability-changed" && event.availability.state === "unavailable")
      this.requests.splice(0);
  }
}
