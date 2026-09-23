import { Schema } from "effect";
import { EditorSelectionId } from "../../../ipc/editor-selection";
import type { EditorSelectionState, EditorSelectionUpdate } from "../../../ipc/editor-selection";
import type { CakeOperationDefinition } from "./cake-operation-registry";
import { agentEditorLocation } from "../../../utils/agent-editor-location";

const vscodeSelectionsListInputSchema = Schema.Struct({});
const vscodeSelectionsRemoveInputSchema = Schema.Struct({ id: EditorSelectionId });
const vscodeSelectionsClearInputSchema = Schema.Struct({});

/**
 * Bound to the calling session through the existing renderer application-control
 * bridge. These calls reach its EditorSelectionsStore, never a main collection.
 * No owning renderer/session Store means an explicit unavailable error.
 */
export interface VscodeSelectionControl {
  listSelections(signal: AbortSignal): Promise<EditorSelectionState>;
  removeSelection(id: EditorSelectionId, signal: AbortSignal): Promise<EditorSelectionUpdate>;
  clearSelections(signal: AbortSignal): Promise<EditorSelectionUpdate>;
}

/**
 * Session-local selection operations backed by the owning renderer Store.
 *
 * vscode.selections.list   {}       -> current IDs + locations, one-based coordinates
 * vscode.selections.remove { id }   -> updated collection + any projection warning
 * vscode.selections.clear  {}       -> empty collection + any projection warning
 *
 * All three work outside VS Code mode while the session Store is available.
 * Remove is idempotent for an unknown ID.
 * Tool schemas validate IDs with EditorSelectionId; no optional ID meaning "all".
 * Guidance must say: ranged vscode.open calls accumulate; selections persist
 * until removed/cleared; list IDs and clear the previous step when advancing a tour.
 * Existing vscode.open gains selectionIds in its result (one per resolved range),
 * while keeping its existing one-based input and file/diff fallback reporting.
 */
export function createCakeVscodeSelectionOperations(
  control: VscodeSelectionControl,
): CakeOperationDefinition[] {
  const stateResult = (state: EditorSelectionState) => ({
    sessionId: state.sessionId,
    selections: state.selections.map(({ id, location }) => ({
      id,
      location: agentEditorLocation(location),
    })),
  });
  const updateResult = (update: EditorSelectionUpdate) => ({
    ...stateResult(update.state),
    ...(update.warning ? { warning: update.warning } : null),
  });
  const guidance = [
    "Ranged vscode.open calls accumulate selections for the calling session, not individual editors.",
    "Selections remain until removed/cleared or the session Store/window closes. They are ephemeral, not persisted across Cake restarts.",
    "List IDs to remove individual selections; clear the previous tour step before presenting the next one.",
    "These operations work while VS Code is hidden, provided the owning session Store is available. Locations use one-based coordinates.",
  ];
  return [
    {
      command: "vscode.selections.list",
      topic: "vscode",
      summary: "List the calling session's code-tour selections.",
      inputSchema: vscodeSelectionsListInputSchema,
      guidance,
      examples: [{}],
      result: "Session identity and ordered selection IDs and one-based locations.",
      async execute(_input, context) {
        return stateResult(await control.listSelections(context.signal));
      },
    },
    {
      command: "vscode.selections.remove",
      topic: "vscode",
      summary: "Remove one code-tour selection by ID.",
      inputSchema: vscodeSelectionsRemoveInputSchema,
      guidance,
      examples: [{ input: { id: "selection-id" } }],
      result:
        "The updated collection and any highlight rendering warning. An unknown ID is a no-op.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry validated this operation's input schema.
        const { id } = input as typeof vscodeSelectionsRemoveInputSchema.Type;
        return updateResult(await control.removeSelection(id, context.signal));
      },
    },
    {
      command: "vscode.selections.clear",
      topic: "vscode",
      summary: "Clear all code-tour selections in the calling session.",
      inputSchema: vscodeSelectionsClearInputSchema,
      guidance,
      examples: [{}],
      result: "The empty collection and any highlight rendering warning.",
      async execute(_input, context) {
        return updateResult(await control.clearSelections(context.signal));
      },
    },
  ];
}
