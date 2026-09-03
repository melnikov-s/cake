import { Context, type Stream } from "effect";
import type { CakeEvent } from "../../ipc/cake-rpc-contract";

export type FocusedCakeEvent<Types extends CakeEvent["type"]> = Extract<
  CakeEvent,
  { readonly type: Types }
>;

export interface NativeEventsService {
  readonly application: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<
      | "workspace-inspected"
      | "changelog-snapshot"
      | "complete"
      | "fatal"
      | "notification"
      | "extension-ui-intent"
      | "project-session-control-requested"
      | "renderer-events-ready"
    >
  >;
  readonly artifacts: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<
      "artifact-updated" | "artifact-requested" | "ui-request" | "renderer-events-ready"
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
      | "embedded-editor-entered"
      | "renderer-events-ready"
    >
  >;
  readonly surfaces: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<"fullscreen-surface-close-requested" | "renderer-events-ready">
  >;
}

export class NativeEvents extends Context.Service<NativeEvents, NativeEventsService>()(
  "cake/services/electron/NativeEvents",
) {}
