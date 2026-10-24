import { observer } from "r-state-tree/react";
import type { SessionPresentationStore } from "../stores/SessionPresentationStore";
import { formatSourceLocation } from "../../utils/source-location";
import { FullscreenMessage } from "./fullscreen-message";

/** Uses Cake's existing transient text reader, never a persisted artifact or transcript. */
export const FileLocationPreview = observer(function FileLocationPreview({
  store,
}: {
  store: SessionPresentationStore;
}) {
  const preview = store.filePreview;
  if (!preview) return null;
  const location = preview.location;
  const changes = location.view === "changes";
  return (
    <FullscreenMessage
      key={preview.path}
      allowSourceView
      eyebrow={
        changes
          ? "Text file · Diff unavailable outside the selected project; showing current file, not the requested revision"
          : location.symbol
            ? `Text file · Symbol lookup unavailable: ${location.symbol}`
            : "Text file · Read only"
      }
      title={formatSourceLocation({ ...location, path: preview.path })}
      text={preview.content}
      markdown={
        /\.(md|markdown|mdown)$/i.test(preview.path) &&
        !location.view &&
        !location.symbol &&
        !location.range &&
        !location.ranges?.length
      }
      sourceRanges={
        changes && location.side === "before"
          ? []
          : (location.ranges ?? (location.range ? [location.range] : []))
      }
      onClose={() => store.closeFilePreview()}
    />
  );
});
