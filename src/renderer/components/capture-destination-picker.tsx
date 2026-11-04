import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import type {
  CaptureDestination,
  CaptureSessionOption,
} from "../../contracts/desktop/screen-capture-data";
import { CaptureDestinationPickerStore } from "../stores/CaptureDestinationPickerStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { CakeIcon, ChevronIcon, ChevronDownIcon, FolderIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Avatar } from "./ui/avatar";
import { NavItem } from "./ui/nav-item";
import { SessionListItem } from "./ui/session-list-item";

/** The original capture menu, composed from shared sidebar rows with capture-scoped disclosures. */
export const CaptureDestinationPicker = observer(function CaptureDestinationPicker({
  disabled,
  ariaLabel = "Screenshot destination",
  variant = "field",
}: {
  disabled: boolean;
  ariaLabel?: string;
  /** `title` makes the pane title itself the trigger. */
  variant?: "field" | "title";
}) {
  const store = useStore(CaptureDestinationPickerStore);
  const [open, setOpen] = useState(false);
  const routing = store.routing;
  const globalChats = routing.cakeChats.filter(
    (session) => !routing.projects.some((project) => project.chatSessionId === session.sessionId),
  );
  const choose = (destination: CaptureDestination) => {
    if (disabled) return;
    store.select(destination);
    setOpen(false);
  };
  const selected = (kind: CaptureDestination["kind"], sessionId: string | undefined) =>
    store.destination?.kind === kind && store.destination.sessionId === sessionId;
  const rows = (sessions: readonly CaptureSessionOption[], kind: "project-session" | "cake-chat") =>
    store
      .visibleSessions(sessions)
      .map((session) => (
        <SessionListItem
          key={session.sessionId}
          session={session}
          managedWorktree={session.managedWorktree}
          selected={selected(kind, session.sessionId)}
          resolved={false}
          activity={session.activity}
          activityTime={session.activityTime}
          labels={session.labels}
          avatarSeed={session.sessionId}
          avatarsEnabled={routing.appearance.sessionAvatarsEnabled}
          charactersEnabled={routing.appearance.sidebarCharactersEnabled}
          familyCollapsed={store.isFamilyCollapsed(session.sessionId)}
          onToggleFamily={(id) => store.toggleFamily(id)}
          onOpen={(sessionId) => choose({ kind, sessionId })}
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
        className={
          variant === "title"
            ? "-ml-2 h-8 min-w-0 max-w-full justify-start gap-1.5 px-2 text-sm font-semibold text-foreground [app-region:no-drag] [&>svg]:text-muted-foreground hover:[&>svg]:text-foreground"
            : "h-7.5 w-52 min-w-0 justify-between gap-2 px-2 text-xs font-normal"
        }
      >
        <span className="truncate">{store.label}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent
        aria-label={ariaLabel}
        align="start"
        className="w-80 max-h-[min(22rem,calc(100vh-9rem))] overflow-y-auto bg-sidebar p-1.5"
      >
        {globalChats.map((chat) => (
          <NavItem
            key={chat.sessionId}
            data-slot="destination-cake-chat"
            label={chat.title || "Cake Chat"}
            icon={<CakeIcon />}
            active={selected("cake-chat", chat.sessionId)}
            disabled={disabled}
            className="mb-1 text-sm"
            onClick={() => choose({ kind: "cake-chat", sessionId: chat.sessionId })}
          />
        ))}
        {routing.projects.map((project) => {
          const collapsed = store.isProjectCollapsed(project.path);
          const chatSelected = selected("cake-chat", project.chatSessionId);
          return (
            <section key={project.path} aria-label={project.name} className="mb-1 last:mb-0">
              <div
                data-slot="project-header"
                className={cn(
                  "grid h-8 w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-1 rounded-md pl-1 pr-2 text-muted-foreground transition-colors",
                  chatSelected && "bg-sidebar-active text-sidebar-selection-foreground",
                )}
              >
                <IconButton
                  className={cn(
                    "size-5 rounded text-muted-foreground transition-transform duration-150 hover:text-foreground",
                    collapsed && "-rotate-90",
                  )}
                  tooltip={collapsed ? "Expand" : "Collapse"}
                  ariaLabel={`${collapsed ? "Expand" : "Collapse"} ${project.name}`}
                  aria-expanded={!collapsed}
                  onClick={() => store.toggleProject(project.path)}
                >
                  <ChevronIcon />
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
                  className={cn(
                    "h-7 w-full min-w-0 justify-start px-1 text-sm font-medium text-inherit hover:text-foreground",
                    chatSelected && "hover:bg-transparent",
                  )}
                  aria-label={`Open Project Chat for ${project.name}`}
                  aria-current={chatSelected ? "page" : undefined}
                  disabled={!project.chatSessionId || disabled}
                  onClick={() => {
                    if (project.chatSessionId)
                      choose({ kind: "cake-chat", sessionId: project.chatSessionId });
                  }}
                >
                  <span className="truncate">{project.name}</span>
                </Button>
              </div>
              {!collapsed && (
                <div className="flex flex-col gap-1 pl-4">
                  {rows(project.sessions, "project-session")}
                </div>
              )}
            </section>
          );
        })}
      </PopoverContent>
    </Popover>
  );
});
