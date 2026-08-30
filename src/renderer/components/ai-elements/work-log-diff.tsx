import type { UiPart } from "../../../ipc/session-contract";
import type { SourceLocation } from "../../../ipc/source-location";
import { workLogChanges } from "../../../utils/turn-diff";
import { toWorkspaceRelativePath } from "../../../utils/workspace-relative-path";
import { DiffView } from "./diff-view";

export function WorkLogDiff({
  parts,
  streaming,
  onOpenSourceLocation,
  workspacePath,
}: {
  parts: readonly UiPart[];
  streaming: boolean;
  onOpenSourceLocation?: (location: SourceLocation) => void | Promise<void>;
  workspacePath?: string;
}) {
  const changes = workLogChanges(parts);
  if (changes.length === 0)
    return streaming ? (
      <div className="p-3 font-mono text-[11px] text-muted-foreground" role="status">
        Waiting for file changes…
      </div>
    ) : null;

  return (
    <div className="grid gap-2" aria-label="Streaming file diff">
      {changes.map((change) => (
        <DiffView
          key={change.path}
          diff={change.diff}
          filePath={toWorkspaceRelativePath(change.path, workspacePath)}
          label={streaming ? "Streaming changes" : "File changes"}
          onOpenSourceLocation={onOpenSourceLocation}
        />
      ))}
    </div>
  );
}
