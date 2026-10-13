import { Context, type Stream } from "effect";
import type { CakeEvent } from "../../contracts/application/cake-rpc-contract";

export type FocusedCakeEvent<Types extends CakeEvent["type"]> = Extract<
  CakeEvent,
  { readonly type: Types }
>;

/** Process-scoped, transient client delivery; subscription lifetimes belong to RPC consumers. */
export interface ClientEventsService {
  /** Synchronous callback boundary. False means no current recipient subscription accepts this event. */
  readonly sendTo: (connectionId: number, event: CakeEvent) => boolean;
  readonly broadcast: (event: CakeEvent) => void;
  readonly application: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<
      | "interview-requested"
      | "changelog-snapshot"
      | "complete"
      | "fatal"
      | "notification"
      | "provider-auth-notice"
      | "extension-ui-intent"
      | "project-session-control-requested"
      | "browser-native-requested"
      | "widget-capture-requested"
      | "screen-capture-requested"
      | "application-hotkey-input"
      | "window-blurred"
      | "browser-entered"
      | "browser-state-changed"
      | "browser-element-selected"
      | "renderer-events-ready"
    >
  >;
  readonly artifacts: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<
      | "artifact-updated"
      | "artifact-catalog-invalidated"
      | "message-board-invalidated"
      | "ui-request"
      | "ui-request-settled"
      | "renderer-events-ready"
    >
  >;
  readonly terminals: (
    connectionId: number,
  ) => Stream.Stream<FocusedCakeEvent<"terminal-toggle-requested" | "renderer-events-ready">>;
  readonly vscode: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<
      | "embedded-editor-toggle-mode-requested"
      | "embedded-editor-selection"
      | "embedded-editor-back-to-agent"
      | "embedded-editor-annotation-opened"
      | "embedded-editor-toggle-chat"
      | "embedded-editor-toggle-sidebar"
      | "embedded-editor-selection-cleared"
      | "embedded-editor-annotation-requested"
      | "embedded-editor-side-chat-requested"
      | "renderer-events-ready"
    >
  >;
  readonly surfaces: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<"fullscreen-surface-close-requested" | "renderer-events-ready">
  >;
}

export class ClientEvents extends Context.Service<ClientEvents, ClientEventsService>()(
  "cake/services/clients/ClientEvents",
) {}
