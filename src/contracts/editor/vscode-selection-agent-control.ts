import type { EditorSelectionId } from "./editor-selection";
import type { EditorSelectionState, EditorSelectionUpdate } from "./editor-selection";

export interface VscodeSelectionControl {
  listSelections(signal: AbortSignal): Promise<EditorSelectionState>;
  removeSelection(id: EditorSelectionId, signal: AbortSignal): Promise<EditorSelectionUpdate>;
  clearSelections(signal: AbortSignal): Promise<EditorSelectionUpdate>;
}
