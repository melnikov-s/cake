import { Context, type Stream } from "effect";
import type { NativeEvent } from "../../ipc/native-protocol";

export type NativeStreamElement = NativeEvent | { readonly type: "native-stream-ready" };

export type FocusedNativeEvent<Types extends NativeEvent["type"]> =
  | Extract<NativeEvent, { readonly type: Types }>
  | { readonly type: "native-stream-ready" };

export interface NativeEventsService {
  readonly application: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedNativeEvent<
      | "pi-state"
      | "workspace-inspected"
      | "changelog-snapshot"
      | "complete"
      | "fatal"
      | "application-state-changed"
      | "notification"
    >
  >;
  readonly artifacts: (
    connectionId: number,
  ) => Stream.Stream<FocusedNativeEvent<"artifact-updated" | "artifact-requested" | "ui-request">>;
  readonly plugins: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedNativeEvent<
      "plugin-backend-event" | "customization-state-changed" | "plugin-agent-event"
    >
  >;
  readonly terminals: (
    connectionId: number,
  ) => Stream.Stream<FocusedNativeEvent<"terminal-toggle-requested">>;
  readonly vscode: (
    connectionId: number,
  ) => Stream.Stream<
    FocusedNativeEvent<
      | "embedded-editor-state"
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
  ) => Stream.Stream<FocusedNativeEvent<"fullscreen-surface-close-requested">>;
}

export class NativeEvents extends Context.Service<NativeEvents, NativeEventsService>()(
  "cake/services/electron/NativeEvents",
) {}
