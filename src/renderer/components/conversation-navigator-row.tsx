import { useEffect, useRef } from "react";
import { observer, useStore } from "r-state-tree/react";
import type { ConversationNavigationNode } from "../lib/conversation-navigation-tree";
import { cn } from "../lib/utils";
import { sessionActivityWithInheritedWorking } from "../lib/session-activity";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import { RootStore } from "../stores/RootStore";
import { SidebarSessionItem } from "./sidebar-session-item";
import { SessionActivityIndicator } from "./session-activity-indicator";
import { Avatar } from "./ui/avatar";
import { DepthRails } from "./ui/depth-rails";
import { IconButton } from "./ui/icon-button";
import { CakeIcon, ChevronIcon } from "./ui/icons";
import { NavItem } from "./ui/nav-item";

/** One compact native source-list row; only working state propagates through descendants. */
export const ConversationNavigatorRow = observer(function ConversationNavigatorRow({
  node,
  depth,
  hideHomeRail = false,
  projectPath,
}: {
  node: ConversationNavigationNode;
  depth: number;
  /** Hide only the Project Chat grouping rail, preserving indentation and family rails. */
  hideHomeRail?: boolean;
  projectPath: string | undefined;
}) {
  const root = useStore(RootStore);
  const store = root.conversationNavigatorStore;
  const selected = store.selectedKey === node.key;
  const expanded = store.isExpanded(projectPath, node.key);
  const row = useRef<HTMLDivElement>(null);
  const project = projectPath
    ? root.projectCatalogModel.projects.find((project) => project.path === projectPath)
    : undefined;
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const relationship =
    node.relationship === "grouped"
      ? "Associated with Project Chat; not a family child"
      : node.relationship === "family-child"
        ? "Session Family child"
        : node.label;
  const session =
    node.target.kind === "project-session"
      ? root.sessionCatalogStore.find(node.target.sessionId)
      : undefined;
  const ownActivity =
    node.target.kind === "cake-chat"
      ? root.cakeChatCollectionStore.ownActivityFor(node.target.sessionId)
      : session
        ? root.sessionMetadataStore.sessionActivity(session.sessionId)
        : node.activity;
  const working = store.effectiveWorking(node);
  const activity = sessionActivityWithInheritedWorking(ownActivity, working);
  const time = working
    ? "Running"
    : node.modifiedAt
      ? formatRelativeSessionTime(node.modifiedAt, root.sidebarStore.now)
      : "Idle";
  return (
    <div
      ref={row}
      data-slot="conversation-navigator-row"
      data-conversation-key={node.key}
      data-session-id={node.target.sessionId}
      data-relationship={node.relationship}
      data-depth={depth}
      data-working={working}
      data-navigation-active={selected}
      className={cn(
        "group flex min-h-11 min-w-0 items-stretch rounded-md",
        selected ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
      )}
    >
      {depth > 0 && (
        <span className="flex shrink-0 items-stretch" style={{ width: Math.min(depth * 6, 24) }}>
          <DepthRails
            depth={depth}
            className={cn(
              "h-auto w-full min-w-0 max-w-none",
              hideHomeRail && "[&>span:first-child]:border-l-0",
            )}
          />
        </span>
      )}
      <span className="flex w-5 shrink-0 items-center justify-center">
        {node.children.length > 0 && (
          <IconButton
            className={cn("size-5 text-muted-foreground [&_svg]:size-3", !expanded && "-rotate-90")}
            tooltip={`${expanded ? "Collapse" : "Expand"} ${node.title}`}
            ariaLabel={`${expanded ? "Collapse" : "Expand"} ${node.title}`}
            aria-expanded={expanded}
            onClick={() => store.toggleExpanded(projectPath, node.key)}
          >
            <ChevronIcon />
          </IconButton>
        )}
      </span>
      {session ? (
        <div className="min-w-0 flex-1">
          <SidebarSessionItem
            store={root.sidebarStore}
            sessionMetadata={root.sessionMetadataStore}
            session={{ ...session, familyDepth: 0 }}
            managedWorktree={root.sidebarStore.managedWorktree(session.workingDirectory)}
            selected={selected}
            resolved={session.resolved}
            activity={activity}
            labels={root.sessionMetadataStore.sessionLabels(session.sessionId)}
            avatarSeed={session.sessionId}
            avatarsEnabled={root.settingsStore.appearance.sessionAvatarsEnabled}
            charactersEnabled={root.settingsStore.appearance.sidebarCharactersEnabled}
            kindLabel={node.label}
            onOpen={() => void store.open(node)}
            onRename={(id, name) => void root.sidebarStore.renameSession(id, name)}
            onResolve={(id, resolved) => void root.sidebarStore.setSessionResolved(id, resolved)}
            onDelete={(id) => void root.sidebarStore.deleteSession(id)}
            onMarkUnread={(id, unread) => void root.sidebarStore.setSessionUnread(id, unread)}
            onSetLabels={(id, ids) => void root.sidebarStore.setSessionLabels(id, ids)}
          />
        </div>
      ) : (
        <NavItem
          active={selected}
          activateOnMouseDown
          className="min-h-11 min-w-0 flex-1 bg-transparent py-1.5 pl-0 text-sm hover:bg-transparent"
          actionProps={{ "aria-label": node.title }}
          label={
            <span className="block truncate" title={`${node.title} — ${relationship}`}>
              {node.title}
            </span>
          }
          icon={
            <span
              className="flex w-6 items-center justify-center [&_[data-slot=icon]]:size-4"
              aria-hidden="true"
            >
              {node.relationship === "home" && !project ? (
                <CakeIcon />
              ) : (
                <Avatar
                  kind={node.relationship === "home" ? "project" : "session"}
                  seed={
                    node.relationship === "home"
                      ? (project?.name ?? node.title)
                      : node.target.sessionId
                  }
                  customIcon={node.relationship === "home" ? project?.settings.icon : undefined}
                  className="size-5"
                />
              )}
            </span>
          }
          description={
            <span className="flex min-w-0 items-center gap-1.5 text-xs leading-none">
              <span
                className="min-w-0 flex-1 truncate"
                title={`${node.label} · ${time} — ${relationship}`}
              >
                {node.label} · {time}
              </span>
            </span>
          }
          trailing={
            <span
              className="flex size-6 items-center justify-center"
              data-slot="own-activity"
              aria-label={activity ? undefined : "Idle"}
              title={activity ? undefined : "Idle"}
            >
              <SessionActivityIndicator activity={activity} />
            </span>
          }
          onClick={() => void store.open(node)}
          onContextMenu={
            node.target.kind === "cake-chat"
              ? (event) => {
                  event.preventDefault();
                  const { clientX, clientY } = event;
                  requestAnimationFrame(
                    () =>
                      void root.cakeChatCollectionStore.showContextMenu(
                        clientX,
                        clientY,
                        node.target.sessionId,
                      ),
                  );
                }
              : undefined
          }
        />
      )}
    </div>
  );
});
