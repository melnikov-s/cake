import type { EditorLocation } from "../contracts/editor/editor-location";
import type { EditorSelectionLocation } from "../contracts/editor/editor-selection";
import type { JsonObject } from "../contracts/serialization/json-contract";

/** Agent/application-control coordinates are one-based; native coordinates are zero-based. */
export function agentEditorLocation(
  location: EditorLocation | EditorSelectionLocation,
): JsonObject {
  return {
    path: location.path,
    ...(location.kind === "working-directory" && location.view === "changes"
      ? {
          view: location.view,
          ...(location.side ? { side: location.side } : null),
          ...(location.base ? { base: location.base } : null),
        }
      : null),
    ...(location.range
      ? {
          line: location.range.start.line + 1,
          ...(location.range.start.column !== undefined
            ? { column: location.range.start.column + 1 }
            : null),
          ...(location.range.end
            ? {
                endLine: location.range.end.line + 1,
                ...(location.range.end.column !== undefined
                  ? { endColumn: location.range.end.column + 1 }
                  : null),
              }
            : null),
        }
      : null),
  };
}
