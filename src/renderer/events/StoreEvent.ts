import type { AgentAvailabilityEntry } from "../../domain/application/agent-availability-data";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { CakeEvent } from "../../ipc/cake-rpc-contract";

type NativePassthroughEvent = Extract<
  CakeEvent,
  { type: "extension-ui-intent" | "project-session-control-requested" }
>;

export type StoreEvent =
  | NativePassthroughEvent
  | {
      type: "agent-availability-changed";
      availability: AgentAvailabilityEntry;
      workingDirectory?: string;
    }
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
  | {
      type: "notification";
      tone: "info" | "warning" | "error";
      title: string;
      message: string;
    }
  | { type: "terminal-data"; terminalId: string; data: string }
  | { type: "terminal-exited"; terminalId: string; exitCode: number }
  | { type: "terminal-toggle-requested" }
  | { type: "embedded-editor-toggle-mode-requested" }
  | { type: "embedded-editor-entered"; workspacePath: string }
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
  | { type: "embedded-editor-toggle-sidebar"; workspacePath: string }
  | { type: "embedded-editor-selection-cleared"; workspacePath: string };

export function toStoreEvent(event: CakeEvent): StoreEvent | undefined {
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
  if (event.type === "notification") return event;
  if (
    event.type === "terminal-data" ||
    event.type === "terminal-exited" ||
    event.type === "terminal-toggle-requested"
  )
    return event;
  if (event.type === "extension-ui-intent" || event.type === "project-session-control-requested")
    return event;
  if (
    event.type === "embedded-editor-toggle-mode-requested" ||
    event.type === "embedded-editor-selection" ||
    event.type === "embedded-editor-annotation-opened" ||
    event.type === "embedded-editor-back-to-agent" ||
    event.type === "embedded-editor-toggle-chat" ||
    event.type === "embedded-editor-toggle-sidebar" ||
    event.type === "embedded-editor-selection-cleared" ||
    event.type === "embedded-editor-entered"
  )
    return event;
  return undefined;
}
