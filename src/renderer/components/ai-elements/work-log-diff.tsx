import type { UiPart } from "../../../ipc/session-contract";
import type { SourceLocation } from "../../../ipc/source-location";
import { workLogChangeChunks } from "../../../utils/turn-diff";
import { toWorkspaceRelativePath } from "../../../utils/workspace-relative-path";
import { DiffView } from "./diff-view";

export function WorkLogDiff({
  parts,
  streaming,
  onOpenSourceLocation,
  workspacePath,
  changeClassName,
  headerClassName,
}: {
  parts: readonly UiPart[];
  streaming: boolean;
  onOpenSourceLocation?: (location: SourceLocation) => void | Promise<void>;
  workspacePath?: string;
  changeClassName?: string;
  headerClassName?: string;
}) {
  const changes = workLogChangeChunks(parts);
  if (changes.length === 0)
    return streaming ? (
      <div className="p-3 font-mono text-[11px] text-muted-foreground" role="status">
        Waiting for file changes…
      </div>
    ) : null;

  return (
    <div className="grid" aria-label="Streaming file diff">
      {changes.map((change) => (
        <DiffView
          key={change.id}
          diff={change.diff}
          filePath={toWorkspaceRelativePath(change.path, workspacePath)}
          label={streaming ? "Streaming changes" : "File changes"}
          onOpenSourceLocation={onOpenSourceLocation}
          className={changeClassName}
          headerClassName={headerClassName}
        />
      ))}
    </div>
  );
}
