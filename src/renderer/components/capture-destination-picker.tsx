import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import type { CaptureSessionOption } from "../../contracts/desktop/screen-capture-data";
import { CaptureDestinationPickerStore } from "../stores/CaptureDestinationPickerStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { CakeIcon, ChevronIcon, ChevronDownIcon, FolderIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Avatar } from "./ui/avatar";
import { SessionListItem } from "./ui/session-list-item";

/** The original capture menu, composed from shared sidebar rows with capture-scoped disclosures. */
export const CaptureDestinationPicker = observer(function CaptureDestinationPicker({
  disabled,
  ariaLabel = "Screenshot destination",
}: {
  disabled: boolean;
  ariaLabel?: string;
}) {
  const store = useStore(CaptureDestinationPickerStore);
  const [open, setOpen] = useState(false);
  const routing = store.routing;
  const globalChats = routing.cakeChats.filter(
    (session) => !routing.projects.some((project) => project.chatSessionId === session.sessionId),
  );
  const rows = (sessions: readonly CaptureSessionOption[], kind: "project-session" | "cake-chat") =>
    store.visibleSessions(sessions).map((session) => (
      <SessionListItem
        key={session.sessionId}
        session={session}
        managedWorktree={session.managedWorktree}
        selected={
          store.destination?.kind === kind && store.destination.sessionId === session.sessionId
        }
        resolved={false}
        activity={session.activity}
        activityTime={session.activityTime}
        labels={session.labels}
        avatarSeed={session.sessionId}
        avatarsEnabled={routing.appearance.sessionAvatarsEnabled}
        charactersEnabled={routing.appearance.sidebarCharactersEnabled}
        familyCollapsed={store.isFamilyCollapsed(session.sessionId)}
        onToggleFamily={(id) => store.toggleFamily(id)}
        onOpen={(sessionId) => {
          if (disabled) return;
          store.select({ kind, sessionId });
          setOpen(false);
        }}
      />
    ));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel}
        title={store.label}
        disabled={disabled}
        variant="ghost"
        size="sm"
        className="h-7.5 w-52 min-w-0 justify-between gap-2 px-2 text-xs font-normal"
      >
        <span className="truncate">{store.label}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent
        aria-label={ariaLabel}
        align="start"
        className="w-80 max-h-[min(22rem,calc(100vh-9rem))] overflow-y-auto bg-sidebar p-1.5"
      >
        {globalChats.length > 0 && (
          <section aria-label="Cake Chat">
            <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              <CakeIcon /> Cake Chat
            </div>
            <div className="flex flex-col gap-1">{rows(globalChats, "cake-chat")}</div>
          </section>
        )}
        {routing.projects.map((project) => (
          <section key={project.path} aria-label={project.name}>
            <div className="flex items-center gap-1">
              <IconButton
                tooltip={store.isProjectCollapsed(project.path) ? "Expand" : "Collapse"}
                ariaLabel={`${store.isProjectCollapsed(project.path) ? "Expand" : "Collapse"} ${project.name}`}
                aria-expanded={!store.isProjectCollapsed(project.path)}
                onClick={() => store.toggleProject(project.path)}
              >
                <ChevronIcon
                  className={cn(store.isProjectCollapsed(project.path) && "-rotate-90")}
                />
              </IconButton>
              {routing.appearance.projectAvatarsEnabled ? (
                <Avatar
                  kind="project"
                  seed={project.name}
                  customIcon={project.icon}
                  aria-hidden="true"
                />
              ) : (
                <FolderIcon />
              )}
              <Button
                data-slot="project-label"
                variant="ghost"
                size="sm"
                className="min-w-0 flex-1 justify-start"
                aria-label={`Open Project Chat for ${project.name}`}
                disabled={!project.chatSessionId || disabled}
                onClick={() => {
                  if (!project.chatSessionId || disabled) return;
                  store.select({ kind: "cake-chat", sessionId: project.chatSessionId });
                  setOpen(false);
                }}
              >
                <span className="truncate">{project.name}</span>
              </Button>
            </div>
            {!store.isProjectCollapsed(project.path) && (
              <div className="flex flex-col gap-1 pl-4">
                {rows(project.sessions, "project-session")}
              </div>
            )}
          </section>
        ))}
      </PopoverContent>
    </Popover>
  );
});
