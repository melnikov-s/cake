import type { ReactElement } from "react";
import { observer, useStore } from "r-state-tree/react";
import { formatSourceLocation } from "../../utils/source-location";
import {
  isAbortError,
  openFileFailureToast,
  selectionHighlightWarningToast,
} from "../lib/open-file-failure";
import type { EditorSelectionsStore } from "../stores/EditorSelectionsStore";
import { RootStore } from "../stores/RootStore";
import { DismissibleChip } from "./ui/dismissible-chip";

/** Session-owned code-tour selections above the authoritative project Chat composer. */
export const EditorSelectionPills = observer(function EditorSelectionPills({
  store,
}: {
  store: EditorSelectionsStore;
}): ReactElement | null {
  const toasts = useStore(RootStore).toastStore;
  if (store.selections.length === 0) return null;
  // Failures are one-off: report them as toasts, never as a notice above the composer.
  const reportOpen = (path: string) => (error: unknown) => {
    if (!isAbortError(error)) toasts.show(openFileFailureToast(path, error));
  };
  const reportWarning = ({ warning }: { warning?: string }) => {
    if (warning) toasts.show(selectionHighlightWarningToast(warning));
  };
  return (
    <div className="flex flex-wrap gap-1" aria-label="Editor selections">
      {store.selections.map(({ id, location }) => {
        const fullLabel = formatSourceLocation(
          location.view === "changes"
            ? {
                path: location.path,
                range: location.range,
                view: "changes",
                side: location.side,
                base: location.base,
              }
            : { path: location.path, range: location.range },
        );
        const filename = location.path.split(/[\\/]/).at(-1) ?? location.path;
        const range = location.range;
        const line = range.start.line + 1;
        const end = range.end?.line;
        const label = `${filename}:${line}${end !== undefined && end !== range.start.line ? `–${end + 1}` : ""}`;
        const tooltip = `${fullLabel}${location.view === "changes" ? ` (${location.side}, base ${location.base})` : ""}`;
        return (
          <DismissibleChip
            key={id}
            title={tooltip}
            aria-label={`Reveal ${tooltip}`}
            removeLabel={`Remove ${tooltip}`}
            onClick={() => void store.reveal(id).catch(reportOpen(location.path))}
            // Removal rejects only after the session's Store is disposed.
            onRemove={() => void store.remove(id).then(reportWarning, () => undefined)}
          >
            {label}
          </DismissibleChip>
        );
      })}
    </div>
  );
});
