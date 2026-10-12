import type { JsonValue } from "../serialization/json-contract";
import type { EditorLocation } from "./editor-location";
import type { VscodeActionResult } from "../vscode/vscode-action-result";
import type { EditorSelectionOpenResult } from "./editor-selection";

import type { VscodeSelectionControl } from "./vscode-selection-agent-control";

export interface VscodeControl extends VscodeSelectionControl {
  enter(signal: AbortSignal): Promise<void>;
  open(
    location: EditorLocation,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<EditorSelectionOpenResult>>;
  runScript(
    source: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<JsonValue>>;
}
