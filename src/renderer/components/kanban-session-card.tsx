import type { DragEvent } from "react";
import type { ProjectWorkflowColor } from "../../domain/application/application-data";
import { ActionCard } from "./ui/action-card";
import { Badge } from "./ui/badge";
import { StatusSwatch } from "./ui/status-swatch";

export interface KanbanSessionCardProps {
  session: {
    sessionId: string;
    title: string;
    draft?: boolean;
    resolved: boolean;
    worktreeName?: string;
  };
  managedWorktree?: { branch: string };
  model?: string;
  description?: string;
  status?: { name: string; color: ProjectWorkflowColor };
  busy: boolean;
  onOpen(): void;
  onDragStart(event: DragEvent<HTMLButtonElement>): void;
  onDragEnd(): void;
}

export function KanbanSessionCard({
  session,
  managedWorktree,
  model,
  description,
  status,
  busy,
  onOpen,
  onDragStart,
  onDragEnd,
}: KanbanSessionCardProps) {
  const worktree = session.worktreeName ?? managedWorktree?.branch.replace(/^agent\//, "");
  return (
    <ActionCard
      data-session-id={session.sessionId}
      className="cursor-grab flex-col items-stretch gap-2.5 p-3 active:cursor-grabbing"
      title={session.title}
      description={description}
      descriptionClassName="whitespace-normal break-words leading-relaxed"
      badge={
        session.draft ? (
          <Badge variant="outline" size="xs">
            Draft
          </Badge>
        ) : session.resolved ? (
          <Badge variant="outline" size="xs">
            Resolved
          </Badge>
        ) : status ? (
          <span className="flex min-w-0 items-center gap-1 text-[10px] font-normal text-muted-foreground">
            <StatusSwatch color={status.color} />
            <span className="truncate">{status.name}</span>
          </span>
        ) : undefined
      }
      disabled={busy}
      draggable={!busy}
      onClick={onOpen}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="flex min-w-0 items-center gap-1.5 border-t border-border/70 pt-2 text-[10px] font-normal text-muted-foreground">
        <span className="truncate">{model ?? "Model unavailable"}</span>
        {worktree && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{worktree}</span>
          </>
        )}
      </span>
    </ActionCard>
  );
}
