import type { DiscussionAnchor } from "../domain/discussion-sessions/discussion-session-data";
import type { Attachment } from "../ipc/session-contract";

/** An explicit VS Code selection handed to Cake; lines and columns are zero-based. */
export interface EditorSelection {
  readonly path: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly selectedText: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
}

/**
 * A selection whose end sits at column 0 of a later line ends on the previous
 * line, matching VS Code's exclusive-end convention for whole-line selections.
 */
function inclusiveEndLine(selection: EditorSelection) {
  return selection.endColumn === 0 && selection.endLine > selection.startLine
    ? selection.endLine - 1
    : selection.endLine;
}

/** Anchors a code discussion at the selection, mirroring Cake's file-view thread anchors. */
export function discussionAnchorFromEditorSelection(selection: EditorSelection): DiscussionAnchor {
  return {
    path: selection.path,
    view: "file",
    start: {
      diffLine: selection.startLine,
      oldLine: selection.startLine + 1,
      newLine: selection.startLine + 1,
      column: selection.startColumn,
    },
    end: {
      diffLine: selection.endLine,
      oldLine: selection.endLine + 1,
      newLine: selection.endLine + 1,
      column: selection.endColumn,
    },
    selectedText: selection.selectedText,
    contextBefore: selection.contextBefore,
    contextAfter: selection.contextAfter,
    diff: "",
  };
}

/** Builds the composer attachment for an explicit source annotation and its optional note. */
export function sourceAttachmentFromEditorSelection(
  selection: EditorSelection,
  comment?: string,
): Extract<Attachment, { kind: "source" }> {
  const note = comment?.trim();
  return {
    kind: "source",
    name: selection.path.slice(-512),
    location: {
      path: selection.path,
      range: {
        start: { line: selection.startLine },
        end: { line: inclusiveEndLine(selection) },
      },
    },
    selectedText: selection.selectedText,
    ...(note ? { comment: note } : null),
  };
}
