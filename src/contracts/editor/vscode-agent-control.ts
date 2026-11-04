import type { JsonValue } from "../serialization/json-contract";
import type { VscodeOpenInput } from "./vscode-tool-input";
import type { VscodeActionResult } from "../vscode/vscode-action-result";
import type { EditorSelectionReveal } from "./editor-selection";

import type { VscodeSelectionControl } from "./vscode-selection-agent-control";

export interface VscodeControl extends VscodeSelectionControl {
  enter(signal: AbortSignal): Promise<void>;
  open(
    location: VscodeOpenInput,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<EditorSelectionReveal>>;
  runScript(
    source: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<JsonValue>>;
}
