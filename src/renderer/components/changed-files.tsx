import { useId } from "react";
import { Button } from "@/components/ui/button";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { ChevronIcon } from "@/components/ui/icons";
import type { UiPart } from "../../ipc/session-contract";
import { workLogChanges } from "../../utils/turn-diff";
import { toWorkspaceRelativePath } from "../../utils/workspace-relative-path";

export function ChangedFiles({
  parts,
  workspacePath,
  open,
  onOpenChange,
  onOpenFile,
}: {
  parts: readonly UiPart[];
  workspacePath?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenFile?(path: string): void;
}) {
  const contentId = useId();
  const changes = workLogChanges(parts);
  if (changes.length === 0) return null;

  return (
    <section
      className="mt-4 overflow-hidden rounded-xl border border-border/80 bg-muted/30"
      aria-label="Changed Files"
    >
      <DisclosureTrigger
        className="px-3.5 py-2.5 hover:bg-muted/50"
        open={open}
        title="Changed Files"
        subtitle={`${changes.length} ${changes.length === 1 ? "file" : "files"}`}
        showChevron={false}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        trailing={
          <ChevronIcon
            className={
              open
                ? "transition-transform duration-150"
                : "-rotate-90 transition-transform duration-150"
            }
          />
        }
      />
      {open && (
        <ul id={contentId} className="divide-y divide-border/60 border-t border-border/60">
          {changes.map((change) => {
            const path = toWorkspaceRelativePath(change.path, workspacePath);
            return (
              <li
                key={change.path}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3.5 py-2 font-mono text-xs"
              >
                {onOpenFile ? (
                  <Button
                    className="h-auto min-w-0 justify-start p-0 font-mono text-xs font-normal text-foreground underline decoration-border underline-offset-4 hover:bg-transparent hover:decoration-foreground"
                    variant="ghost"
                    title={`Open ${path} in VS Code Changes`}
                    onClick={() => onOpenFile(path)}
                  >
                    <code className="truncate font-inherit">{path}</code>
                  </Button>
                ) : (
                  <code className="truncate font-inherit text-foreground" title={path}>
                    {path}
                  </code>
                )}
                <span className="font-semibold text-success tabular-nums">+{change.additions}</span>
                <span className="font-semibold text-destructive tabular-nums">
                  −{change.deletions}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
