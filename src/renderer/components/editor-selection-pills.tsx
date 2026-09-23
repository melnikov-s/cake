import type { ReactElement } from "react";
import { observer } from "r-state-tree/react";
import { formatSourceLocation } from "../../utils/source-location";
import type { EditorSelectionsStore } from "../stores/EditorSelectionsStore";
import { Callout } from "./ui/callout";
import { DismissibleChip } from "./ui/dismissible-chip";

/** Session-owned code-tour selections above the authoritative project Chat composer. */
export const EditorSelectionPills = observer(function EditorSelectionPills({
  store,
}: {
  store: EditorSelectionsStore;
}): ReactElement | null {
  if (store.selections.length === 0 && !store.error) return null;
  return (
    <div className="flex flex-col gap-2">
      {store.selections.length > 0 && (
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
                onClick={() => void store.reveal(id).catch(() => undefined)}
                onRemove={() => void store.remove(id).catch(() => undefined)}
              >
                {label}
              </DismissibleChip>
            );
          })}
        </div>
      )}
      {store.error && (
        <Callout variant="warning" role="status">
          {store.error}
        </Callout>
      )}
    </div>
  );
});
