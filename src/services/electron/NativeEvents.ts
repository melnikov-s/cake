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
      "workspace-inspected" | "changelog-snapshot" | "complete" | "fatal" | "notification"
    >
  >;
  readonly artifacts: (
    connectionId: number,
  ) => Stream.Stream<FocusedCakeEvent<"artifact-updated" | "artifact-requested" | "ui-request">>;
  readonly plugins: (
    connectionId: number,
  ) => Stream.Stream<FocusedCakeEvent<"plugin-backend-event" | "plugin-agent-event">>;
  readonly terminals: (
    connectionId: number,
  ) => Stream.Stream<FocusedCakeEvent<"terminal-toggle-requested">>;
  readonly vscode: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedCakeEvent<
      | "embedded-editor-selection"
      | "embedded-editor-back-to-agent"
      | "embedded-editor-annotation-opened"
      | "embedded-editor-toggle-chat"
      | "embedded-editor-selection-cleared"
      | "embedded-editor-location-opened"
    >
  >;
  readonly surfaces: (
    connectionId: number,
  ) => Stream.Stream<FocusedCakeEvent<"fullscreen-surface-close-requested">>;
}

export class NativeEvents extends Context.Service<NativeEvents, NativeEventsService>()(
  "cake/services/electron/NativeEvents",
) {}
