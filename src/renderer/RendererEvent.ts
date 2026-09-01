import type { PrivilegedEvent } from "../ipc/privileged-contract";
import type { ApplicationState } from "../ipc/session-contract";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { SourceLocation } from "../ipc/source-location";
import type { CustomizationState } from "../plugin/plugin-contract";
import type { PluginAgentSnapshot } from "../ipc/plugin-agent-contract";
import type { EmbeddedEditorStatus } from "./client/RendererClient";

export type PiState = "starting" | "ready" | "stopped" | "failed";

type PrivilegedPassthroughEvent = Extract<
  PrivilegedEvent,
  {
    type: "plugin-backend-event" | "fullscreen-surface-close-requested" | "artifact-updated";
  }
>;

export type RendererEvent =
  | PrivilegedPassthroughEvent
  | { type: "pi-state-changed"; state: PiState; workspacePath?: string }
  | { type: "workspace-inspected"; operationId: string; path: string; trustRequired: boolean }
  | {
      type: "changelog-received";
      operationId: string;
      workspacePath: string;
      sessionId: string;
      markdown: string;
    }
  | {
      type: "artifact-requested";
      operationId: string;
      artifactRequestId: string;
      record: ArtifactRecord;
    }
  | {
      type: "ui-requested";
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
  | { type: "operation-completed"; operationId: string }
  | { type: "operation-failed"; operationId?: string; message: string; details?: string }
  | { type: "customization-state-changed"; state: CustomizationState }
  | { type: "application-state-changed"; state: ApplicationState }
  | {
      type: "notification";
      tone: "info" | "warning" | "error";
      title: string;
      message: string;
    }
  | { type: "plugin-agent-event"; pluginId: string; snapshot: PluginAgentSnapshot }
  | { type: "terminal-data"; terminalId: string; data: string }
  | { type: "terminal-exited"; terminalId: string; exitCode: number }
  | { type: "terminal-toggle-requested" }
  | { type: "embedded-editor-state-received"; status: EmbeddedEditorStatus; message?: string }
  | {
      type: "embedded-editor-location-opened";
      workspacePath: string;
      location: SourceLocation;
    }
  | {
      type: "embedded-editor-selection";
      workspacePath: string;
      path: string;
      startLine: number;
      endLine: number;
    }
  | { type: "embedded-editor-back-to-agent"; workspacePath: string }
  | {
      type: "embedded-editor-annotation-opened";
      workspacePath: string;
      sessionId: string;
      threadId: string;
    }
  | { type: "embedded-editor-toggle-chat"; workspacePath: string }
  | { type: "embedded-editor-selection-cleared"; workspacePath: string };

export function toRendererEvent(event: PrivilegedEvent): RendererEvent | undefined {
  if (event.type === "pi-state")
    return { type: "pi-state-changed", state: event.state, workspacePath: event.workspacePath };
  if (event.type === "workspace-inspected")
    return {
      type: "workspace-inspected",
      operationId: event.requestId,
      path: event.path,
      trustRequired: event.trustRequired,
    };
  if (event.type === "plugin-agent-event") return event;
  if (event.type === "artifact-requested")
    return {
      type: "artifact-requested",
      operationId: event.requestId,
      artifactRequestId: event.artifactRequestId,
      record: event.record,
    };
  if (event.type === "changelog-snapshot")
    return {
      type: "changelog-received",
      operationId: event.requestId,
      workspacePath: event.workspacePath,
      sessionId: event.sessionId,
      markdown: event.markdown,
    };
  if (event.type === "ui-request")
    return {
      type: "ui-requested",
      operationId: event.requestId,
      uiRequestId: event.uiRequestId,
      kind: event.kind,
      title: event.title,
      message: event.message,
      placeholder: event.placeholder,
      initialValue: event.initialValue,
      multiline: event.multiline,
      options: event.options,
    };
  if (event.type === "complete")
    return { type: "operation-completed", operationId: event.requestId };
  if (event.type === "fatal")
    return {
      type: "operation-failed",
      operationId: event.requestId,
      message: event.message,
      details: event.details,
    };
  if (event.type === "customization-state-changed") return event;
  if (event.type === "application-state-changed" || event.type === "notification") return event;
  if (
    event.type === "terminal-data" ||
    event.type === "terminal-exited" ||
    event.type === "terminal-toggle-requested"
  )
    return event;
  if (event.type === "embedded-editor-state")
    return {
      type: "embedded-editor-state-received",
      status: event.status,
      message: event.message,
    };
  if (
    event.type === "plugin-backend-event" ||
    event.type === "fullscreen-surface-close-requested" ||
    event.type === "artifact-updated"
  )
    return event;
  if (
    event.type === "embedded-editor-selection" ||
    event.type === "embedded-editor-annotation-opened" ||
    event.type === "embedded-editor-back-to-agent" ||
    event.type === "embedded-editor-toggle-chat" ||
    event.type === "embedded-editor-selection-cleared" ||
    event.type === "embedded-editor-location-opened"
  )
    return event;
  return undefined;
}
