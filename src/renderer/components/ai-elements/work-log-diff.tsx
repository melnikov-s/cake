import type { UiPart } from "../../../ipc/session-contract";
import { workLogChanges } from "../../../utils/turn-diff";
import { DiffView } from "./diff-view";

export function WorkLogDiff({
  parts,
  streaming,
  onOpenFile,
}: {
  parts: readonly UiPart[];
  streaming: boolean;
  onOpenFile?: (path: string) => void | Promise<void>;
}) {
  const changes = workLogChanges(parts);
  if (changes.length === 0)
    return (
      <div className="work-log-diff-empty" role="status">
        {streaming ? "Waiting for file changes…" : "No file changes in this work log."}
      </div>
    );

  return (
    <div className="work-log-diff" aria-label="Streaming file diff">
      {changes.map((change) => (
        <DiffView
          key={change.path}
          diff={change.diff}
          filePath={change.path}
          label={streaming ? "Streaming changes" : "File changes"}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}
