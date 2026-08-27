import type {
  EditorAnnotation,
  EditorAnnotationSnapshot,
  EditorAnnotationStatus,
} from "../ipc/editor-annotation";
import type { ReviewThread } from "../models/ReviewThread";

export function reviewThreadAnnotations(
  sessionId: string,
  threads: readonly ReviewThread[],
  streaming: (threadId: string) => boolean,
): EditorAnnotationSnapshot {
  return {
    sessionId,
    annotations: threads.flatMap((thread) => {
      if (thread.anchor.view === "message") return [];
      const startLine = sourceLine(thread.anchor.start);
      const endLine = Math.max(startLine, sourceLine(thread.anchor.end));
      const firstComment =
        thread.textParts.find((part) => part.role === "user")?.text?.trim() ?? "";
      const annotation: EditorAnnotation = {
        id: thread.id,
        location: {
          path: thread.anchor.path,
          range: {
            start: { line: startLine, column: thread.anchor.start.column },
            end: { line: endLine, column: thread.anchor.end.column },
          },
        },
        status: annotationStatus(thread, streaming(thread.id)),
        replyCount: Math.max(0, thread.messageCount - 1),
        preview: firstComment.slice(0, 512),
      };
      return [annotation];
    }),
  };
}

function sourceLine(point: ReviewThread["anchor"]["start"]) {
  return Math.max(0, (point.newLine ?? point.oldLine ?? point.diffLine + 1) - 1);
}

function annotationStatus(thread: ReviewThread, streaming: boolean): EditorAnnotationStatus {
  if (thread.status === "resolved") return "resolved";
  if (thread.pending || streaming) return "pending";
  if (thread.textParts.some((part) => part.role === "assistant")) return "answered";
  return "open";
}
