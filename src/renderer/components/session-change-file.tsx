import { Button } from "./ui/button";
import { FileIcon } from "./ui/icons";
import { ChangeStats } from "./ui/change-stats";
import type { ChangedFile } from "../../contracts/worktrees/worktree-changes";
import type { SessionChangesStore } from "../stores/SessionChangesStore";

export function SessionChangeFile({
  file,
  store,
  contribution = false,
}: {
  file: ChangedFile;
  store: SessionChangesStore;
  contribution?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto w-full justify-start gap-2 rounded-none px-4 py-1.5 text-xs font-normal text-foreground"
      title={`${file.path} · Open changes in VS Code`}
      onClick={() => void store.openFile(file, contribution)}
    >
      <span className="shrink-0 text-muted-foreground">
        <FileIcon />
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{file.path}</span>
      {file.deleted && <span className="font-mono text-xs text-destructive">D</span>}
      <ChangeStats additions={file.additions} deletions={file.deletions} />
    </Button>
  );
}
