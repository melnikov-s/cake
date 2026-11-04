import type { VscodeSelectionControl } from "../../contracts/editor/vscode-selection-agent-control";
import { Schema } from "effect";
import { EditorSelectionId } from "../../contracts/editor/editor-selection";
import type {
  EditorSelectionState,
  EditorSelectionUpdate,
} from "../../contracts/editor/editor-selection";
import { editorRevealOutcomeSchema } from "../../contracts/editor/editor-location";
import {
  VscodeSelectionInput,
  VscodeSelectionsInput,
} from "../../contracts/editor/vscode-tool-input";
import type {
  CakeOperationDefinition,
  CakeOperationResult,
} from "../../contracts/agent/cake-operation";
import { agentEditorLocation } from "../../utils/agent-editor-location";
import { AgentListInput, agentListPage } from "../../contracts/agent/agent-list-data";
const vscodeSelectionsRemoveInputSchema = Schema.Struct({ id: EditorSelectionId });
const vscodeSelectionsClearInputSchema = Schema.Struct({});

const vscodeSelectionsWriteOutput = Schema.Union([
  Schema.Struct({
    sessionId: Schema.String,
    total: Schema.Int,
    offset: Schema.Int,
    nextOffset: Schema.NullOr(Schema.Int),
    selections: Schema.Array(
      Schema.Struct({ id: EditorSelectionId, location: VscodeSelectionInput }),
    ),
    selectionIds: Schema.Array(EditorSelectionId),
    reveals: Schema.Array(
      Schema.Struct({
        outcome: editorRevealOutcomeSchema,
        locations: Schema.Array(VscodeSelectionInput),
      }),
    ),
    warning: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.Literal("VSCODE_MODE_REQUIRED"),
      retryable: Schema.Literal(true),
      recovery: Schema.String,
    }),
  }),
]);

/** Renderer-owned, session-local selection management. No main-owned mirror. */
export function createCakeVscodeSelectionOperations(
  control: VscodeSelectionControl,
): CakeOperationDefinition[] {
  const stateResult = (state: EditorSelectionState, input: AgentListInput = {}) => {
    const query = input.query?.toLowerCase();
    const selected = state.selections.filter(
      ({ location }) => !query || location.path.toLowerCase().includes(query),
    );
    const { items, ...page } = agentListPage(selected, input);
    return {
      sessionId: state.sessionId,
      ...page,
      selections: items.map(({ id, location }) => ({
        id,
        location: agentEditorLocation(location),
      })),
    };
  };
  const updateResult = (update: EditorSelectionUpdate) => ({
    ...stateResult(update.state),
    ...(update.warning ? { warning: update.warning } : null),
  });
  const guidance = [
    "vscode.open only navigates. Use vscode.selections.add to append ranges or vscode.selections.set to replace the calling session’s collection.",
    "Selections remain until removed/cleared or the session Store/window closes. They are ephemeral, not persisted across Cake restarts.",
    "List IDs to remove individual selections; use set for the next tour step.",
    "List/remove/clear work while VS Code is hidden, provided the owning session Store is available. Locations use one-based coordinates.",
  ];
  return [
    ...(["add", "set"] as const).map((operation): CakeOperationDefinition => ({
      command: `vscode.selections.${operation}`,
      topic: "vscode",
      summary:
        operation === "add"
          ? "Append source ranges to the calling session's selections."
          : "Replace the calling session's selection set coherently.",
      inputSchema: VscodeSelectionsInput,
      outputSchema: vscodeSelectionsWriteOutput,
      guidance: [
        ...guidance,
        "Each selection requires path and one-based line; optional column, endLine and endColumn define the range. Omitted end coordinates extend through the final line. Up to 50 entries per call.",
        "Use view changes, optional side before/after (default after) and base revision (default HEAD) for native diffs. If no diff is available the file range is used and reveals reports the fallback.",
        "All entries are validated and resolved before changing the collection. Invalid or unresolvable input leaves existing selections intact. Navigation during resolution is not rolled back.",
        "Exact resolved duplicates reuse IDs. Empty add is a no-op; empty set clears. Highlights refresh once after the mutation; a projection failure returns a warning without undoing the selection state.",
        "Adding/replacing requires vscode.enter and the calling session selected. External read-only files cannot provide editor selections.",
      ],
      examples: [
        {
          input: {
            selections: [
              { path: "src/main.ts", line: 55, endLine: 64, view: "changes", base: "main" },
            ],
          },
        },
      ],
      result:
        "Updated selection page and session ID, requested selectionIds, resolved reveals and optional projection warning; or VSCODE_MODE_REQUIRED.",
      async execute(input, context): Promise<CakeOperationResult> {
        const selections = Schema.decodeUnknownSync(VscodeSelectionsInput)(input);
        const result = await (operation === "add"
          ? control.addSelections(selections, context.signal)
          : control.setSelections(selections, context.signal));
        if (result.status === "mode-required")
          return {
            ok: false,
            error: {
              code: "VSCODE_MODE_REQUIRED",
              retryable: true,
              recovery: "Select the calling session, call vscode.enter, then retry.",
            },
          };
        return {
          ...updateResult(result.value),
          selectionIds: [...result.value.selectionIds],
          reveals: result.value.reveals.map((reveal) => ({
            outcome: { ...reveal.outcome },
            locations: reveal.locations.map(agentEditorLocation),
          })),
        };
      },
    })),
    {
      command: "vscode.selections.list",
      topic: "vscode",
      summary: "List the calling session's code-tour selections.",
      inputSchema: AgentListInput,
      guidance: [
        ...guidance,
        "Filter paths with query; offset/limit page selections (default 20, maximum 50).",
      ],
      examples: [{}],
      result: "Session identity, ordered selection IDs/one-based locations, total and nextOffset.",
      async execute(input, context) {
        return stateResult(
          await control.listSelections(context.signal),
          Schema.decodeUnknownSync(AgentListInput)(input),
        );
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
        "The first bounded page of updated selections, continuation and any highlight rendering warning. An unknown ID is a no-op.",
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
