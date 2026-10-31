import { useState } from "react";
import type {
  CaptureDestination,
  CaptureRouting,
  CaptureSessionOption,
} from "../../../contracts/desktop/screen-capture-data";
import { Button } from "./button";
import { BackIcon, CakeIcon, ChevronIcon, ChevronDownIcon, FolderIcon, PlusIcon } from "./icons";
import { IconButton } from "./icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Avatar } from "./avatar";
import { NavItem } from "./nav-item";
import { cn } from "../../lib/utils";
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
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const projectIcon = (project: CaptureRouting["projects"][number]) =>
    routing.appearance.projectAvatarsEnabled ? (
      <Avatar kind="project" seed={project.name} customIcon={project.icon} aria-hidden="true" />
    ) : (
      <FolderIcon />
    );
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
        className="w-80 overflow-hidden bg-sidebar p-0"
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
              <NavItem
                key={project.path}
                icon={projectIcon(project)}
                label={project.name}
                active={
                  destination.kind === "new-session" && destination.projectPath === project.path
                }
                actionProps={{ "aria-label": `New chat in ${project.name}` }}
                onClick={() => select({ kind: "new-session", projectPath: project.path })}
              />
            ))
          ) : (
            <>
              {routing.cakeChats.length > 0 && (
                <section aria-label="Cake Chat">
                  <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    <CakeIcon /> Cake Chat
                  </div>
                  <div className="flex flex-col gap-1">{rows(routing.cakeChats, "cake-chat")}</div>
                </section>
              )}
              {routing.projects.map((project) => (
                <section key={project.path} aria-label={project.name}>
                  <NavItem
                    icon={
                      <span className="flex items-center gap-1">
                        <ChevronIcon
                          className={cn(collapsedProjects.has(project.path) && "-rotate-90")}
                        />
                        {projectIcon(project)}
                      </span>
                    }
                    label={project.name}
                    actionProps={{
                      "aria-label": `${collapsedProjects.has(project.path) ? "Expand" : "Collapse"} ${project.name}`,
                    }}
                    onClick={() =>
                      setCollapsedProjects((current) => {
                        const next = new Set(current);
                        if (next.has(project.path)) next.delete(project.path);
                        else next.add(project.path);
                        return next;
                      })
                    }
                  />
                  {!collapsedProjects.has(project.path) && (
                    <div className="flex flex-col gap-1 pl-4">
                      {rows(project.sessions, "project-session")}
                    </div>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
