import type { ToastInput } from "../stores/ToastStore";

/** Keeps the file recognizable in a narrow toast; the details keep the whole path. */
function shortDisplayPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join("/")}` : path;
}

/** A failed user file open is a one-off action failure: a toast, never chat content. */
export function openFileFailureToast(path: string, error: unknown): ToastInput {
  const message = error instanceof Error ? error.message || error.name : String(error);
  return {
    tone: "error",
    title: "Could not open file",
    message: shortDisplayPath(path),
    details: `${path}\n\n${message}`,
    coalesceKey: `open-file:${path}`,
  };
}

/** Highlight refresh is secondary to navigation: warn once, keep the selections. */
export function selectionHighlightWarningToast(warning: string): ToastInput {
  return {
    tone: "warning",
    title: "Editor highlights are out of date",
    message: warning,
    coalesceKey: "editor-selection-highlights",
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
