import { Model, observable } from "r-state-tree";
import type { ExtensionUiState, ResourceDiagnostic } from "../../ipc/session-contract";

export interface ExtensionNotification {
  id: string;
  message: string;
  tone: "info" | "warning" | "error";
}

/** Passive renderer projection of session-bound Pi Extension UI state. */
export class ExtensionUi extends Model {
  revision = 0;
  title: string | undefined;
  statuses: Array<ExtensionUiState["statuses"][number]> = observable([]);
  notifications: ExtensionNotification[] = observable([]);
  compatibilityDiagnostics: ResourceDiagnostic[] = observable([]);
  editorText: { text: string; mode: "replace" | "insert" } | undefined;
  editorTextRevision = 0;
}
