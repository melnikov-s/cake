import { Model, observable } from "r-state-tree";
import type { ExtensionUiState, ResourceDiagnostic } from "../../ipc/session-contract";

export interface ExtensionCompanionProjection {
  id: string;
  name: string;
  slot: "composer.above";
  moduleUrl: string;
  actions: readonly string[];
  state: unknown;
}

/** Passive renderer projection of session-bound Pi Extension UI state. */
export class ExtensionUi extends Model {
  title: string | undefined;
  statuses: Array<ExtensionUiState["statuses"][number]> = observable([]);
  companions: ExtensionCompanionProjection[] = observable([]);
  compatibilityDiagnostics: ResourceDiagnostic[] = observable([]);
}
