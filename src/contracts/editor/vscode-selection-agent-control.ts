import type { EditorSelectionId } from "./editor-selection";
import type { EditorSelectionState, EditorSelectionUpdate } from "./editor-selection";

import type { VscodeSelectionsInput } from "./vscode-tool-input";
import type { EditorSelectionsWriteResult } from "./editor-selection";
import type { VscodeActionResult } from "../vscode/vscode-action-result";

export interface VscodeSelectionControl {
  addSelections(
    input: VscodeSelectionsInput,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<EditorSelectionsWriteResult>>;
  setSelections(
    input: VscodeSelectionsInput,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<EditorSelectionsWriteResult>>;
  listSelections(signal: AbortSignal): Promise<EditorSelectionState>;
  removeSelection(id: EditorSelectionId, signal: AbortSignal): Promise<EditorSelectionUpdate>;
  clearSelections(signal: AbortSignal): Promise<EditorSelectionUpdate>;
}
