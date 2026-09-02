import { Model, observable } from "r-state-tree";
import type { ExtensionUiState, ResourceDiagnostic } from "../../ipc/session-contract";

/** Passive renderer projection of session-bound Pi Extension UI state. */
export class ExtensionUi extends Model {
  title: string | undefined;
  statuses: Array<ExtensionUiState["statuses"][number]> = observable([]);
  compatibilityDiagnostics: ResourceDiagnostic[] = observable([]);
}
