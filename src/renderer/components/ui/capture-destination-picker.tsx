import { useState } from "react";
import type {
  CaptureDestination,
  CaptureRouting,
  CaptureSessionOption,
} from "../../../contracts/desktop/screen-capture-data";
import { Button } from "./button";
import { BackIcon, ChevronDownIcon, FolderIcon, PlusIcon } from "./icons";
import { IconButton } from "./icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { SessionListItem } from "./session-list-item";

/** Sidebar rows and order, with a pinned New chat action above the scrolling destinations. */
export function CaptureDestinationPicker({
  routing,
  destination,
  disabled,
  onChange,
}: {
  routing: CaptureRouting;
  destination: CaptureDestination;
  disabled: boolean;
  onChange(destination: CaptureDestination): void;
}) {
  const [open, setOpen] = useState(false);
  const [choosingProject, setChoosingProject] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () =>
      new Set(
        routing.projects.flatMap((project) =>
          project.sessions
            .filter((session) => session.familyCollapsed)
            .map((session) => session.sessionId),
        ),
      ),
  );
  const selectedSession =
    destination.kind === "new-session"
      ? undefined
      : [...routing.cakeChats, ...routing.projects.flatMap((project) => project.sessions)].find(
          (session) => session.sessionId === destination.sessionId,
        );
  const label =
    destination.kind === "new-session"
      ? `New chat · ${routing.projects.find((project) => project.path === destination.projectPath)?.name ?? "Project"}`
      : selectedSession?.title || "Untitled session";
  const select = (next: CaptureDestination) => {
    if (disabled) return;
    onChange(next);
    setOpen(false);
  };
  const rows = (
    sessions: readonly CaptureSessionOption[],
    kind: "project-session" | "cake-chat",
  ) => {
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    return sessions
      .filter((session) => {
        let parent = session.familyParentSessionId;
        const visited = new Set([session.sessionId]);
        while (parent && !visited.has(parent)) {
          if (collapsed.has(parent)) return false;
          visited.add(parent);
          parent = byId.get(parent)?.familyParentSessionId;
        }
        return true;
      })
      .map((session) => (
        <SessionListItem
          key={session.sessionId}
          session={session}
          managedWorktree={session.managedWorktree}
          selected={destination.kind === kind && destination.sessionId === session.sessionId}
          resolved={false}
          activity={session.activity}
          activityTime={session.activityTime}
          labels={session.labels}
          avatarSeed={session.sessionId}
          avatarsEnabled={routing.appearance.sessionAvatarsEnabled}
          charactersEnabled={routing.appearance.sidebarCharactersEnabled}
          familyCollapsed={collapsed.has(session.sessionId)}
          onToggleFamily={(id) =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onOpen={(sessionId) => select({ kind, sessionId })}
        />
      ));
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setChoosingProject(false);
      }}
    >
      <PopoverTrigger
        aria-label="Screenshot destination"
        title={label}
        disabled={disabled}
        variant="ghost"
        size="sm"
        className="h-7.5 w-52 min-w-0 justify-between gap-2 px-2 text-xs font-normal"
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Screenshot destination"
        align="start"
        className="w-80 overflow-hidden p-0"
      >
        <div className="border-b border-border p-1.5">
          {choosingProject ? (
            <div className="flex items-center gap-2 text-xs">
              <IconButton tooltip="Back to sessions" onClick={() => setChoosingProject(false)}>
                <BackIcon />
              </IconButton>
              <span>New chat in…</span>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              disabled={routing.projects.length === 0}
              onClick={() => setChoosingProject(true)}
            >
              <PlusIcon />
              New chat
            </Button>
          )}
        </div>
        <div className="max-h-[min(22rem,calc(100vh-9rem))] overflow-y-auto p-1.5">
          {choosingProject ? (
            routing.projects.map((project) => (
              <Button
                key={project.path}
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                aria-label={`New chat in ${project.name}`}
                onClick={() => select({ kind: "new-session", projectPath: project.path })}
              >
                <FolderIcon />
                {project.name}
              </Button>
            ))
          ) : (
            <>
              {routing.cakeChats.length > 0 && (
                <section aria-label="Cake Chat">
                  <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    Cake Chat
                  </div>
                  {rows(routing.cakeChats, "cake-chat")}
                </section>
              )}
              {routing.projects.map((project) => (
                <section key={project.path} aria-label={project.name}>
                  <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    {project.name}
                  </div>
                  <div className="pl-4">{rows(project.sessions, "project-session")}</div>
                </section>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
