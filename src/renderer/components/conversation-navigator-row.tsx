import { useEffect, useRef, type CSSProperties } from "react";
import { observer, useStore } from "r-state-tree/react";
import type { ConversationNavigationNode } from "../lib/conversation-navigation-tree";
import { cn } from "../lib/utils";
import { sessionActivityWithInheritedWorking } from "../lib/session-activity";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import { RootStore } from "../stores/RootStore";
import { SidebarSessionItem } from "./sidebar-session-item";
import { SessionActivityIndicator } from "./session-activity-indicator";
import { AutoMergeToggle } from "./auto-merge-toggle";
import { Avatar } from "./ui/avatar";
import { DepthRails } from "./ui/depth-rails";
import { IconButton } from "./ui/icon-button";
import { CakeIcon, ChevronIcon } from "./ui/icons";
import { NavItem } from "./ui/nav-item";
import { SessionPurposeIndicator } from "./ui/session-purpose-indicator";

/** One compact native source-list row; only working state propagates through descendants. */
export const ConversationNavigatorRow = observer(function ConversationNavigatorRow({
  node,
  depth,
  underProjectHeading = false,
  projectPath,
  containingProjectPath = projectPath,
}: {
  node: ConversationNavigationNode;
  depth: number;
  /** The Project Chat heading adds indentation, not a Session Family connector. */
  underProjectHeading?: boolean;
  projectPath: string | undefined;
  /** Project identity already supplied by a containing heading or project-scoped layout. */
  containingProjectPath?: string;
}) {
  const root = useStore(RootStore);
  const store = root.conversationNavigatorStore;
  const selected = store.selectedKey === node.key;
  const expanded = store.isExpanded(projectPath, node.key);
  const avatarsEnabled = root.settingsStore.appearance.sessionAvatarsEnabled;
  const headingIndent = underProjectHeading && depth > 0;
  const railCount = depth - Number(headingIndent);
  const gutterStyle: CSSProperties & { "--ancestor-count": number } = {
    "--ancestor-count": railCount,
  };
  const row = useRef<HTMLDivElement>(null);
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
  const rowProjectPath =
    projectPath ??
    session?.projectPath ??
    (node.target.kind === "cake-chat"
      ? root.cakeChatCatalogModel.sessions.find((chat) => chat.sessionId === node.target.sessionId)
          ?.projectPath
      : undefined);
  const project = rowProjectPath ? root.projectCatalogStore.find(rowProjectPath) : undefined;
  const ownActivity =
    node.target.kind === "cake-chat"
      ? root.cakeChatCollectionStore.ownActivityFor(node.target.sessionId)
      : session
        ? root.sessionMetadataStore.sessionActivity(session.sessionId)
        : node.activity;
  const working = store.effectiveWorking(node);
  const activity = sessionActivityWithInheritedWorking(ownActivity, working);
  const hideRunningSubtitle = node.relationship === "home" && projectPath !== undefined && working;
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
        "group flex min-w-0 items-stretch rounded-md",
        hideRunningSubtitle ? "min-h-9" : "min-h-11",
        selected ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
      )}
    >
      {depth > 0 && (
        <span
          className={cn(
            "relative w-[calc(var(--heading-indent)+var(--ancestor-count)*var(--indent-step))] shrink-0",
            headingIndent ? "[--heading-indent:6px]" : "[--heading-indent:0px]",
            // The avatar is centered in the second session-leading column, after the navigator's
            // disclosure track. A 2rem step places the guide at the edge of the next row's
            // disclosure track, outside its glyph. With avatars hidden, anchor to the disclosure.
            avatarsEnabled
              ? "[--icon-center:3.25rem] [--indent-step:2rem]"
              : "[--icon-center:0.625rem] [--indent-step:1rem]",
          )}
          style={gutterStyle}
        >
          <DepthRails
            depth={railCount}
            className="pointer-events-none absolute inset-y-0 left-[calc(var(--heading-indent)+var(--icon-center)-0.5px)] h-auto w-max min-w-0 max-w-none justify-start gap-[calc(var(--indent-step)-1px)] [&>span]:w-px [&>span]:flex-none"
          />
        </span>
      )}
      <span className="flex w-5 shrink-0 items-center justify-center">
        {node.children.length > 0 && (
          <IconButton
            iconSize="inline"
            className={cn("size-5 text-muted-foreground", !expanded && "-rotate-90")}
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
            avatarsEnabled={avatarsEnabled}
            charactersEnabled={root.settingsStore.appearance.sidebarCharactersEnabled}
            showIdleStatus
            source={
              containingProjectPath !== session.projectPath
                ? {
                    kind: "project",
                    name: project?.name ?? session.projectName,
                    avatarSeed: project?.name ?? session.projectName,
                    customIcon: project?.settings.icon,
                    showAvatar: true,
                  }
                : undefined
            }
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
          className={cn(
            "min-w-0 flex-1 bg-transparent py-1.5 pl-0 text-sm hover:bg-transparent",
            // Let the toggle label truncate before it runs into the project avatar and title.
            node.relationship === "home" &&
              rowProjectPath !== undefined &&
              "grid-cols-[minmax(4rem,1fr)_minmax(0,max-content)]",
            hideRunningSubtitle ? "min-h-9" : "min-h-11",
          )}
          actionProps={{ "aria-label": node.title }}
          label={
            <span
              className="flex min-w-0 items-center gap-1.5"
              title={`${node.title} — ${relationship}`}
            >
              {node.target.kind === "subagent" && <SessionPurposeIndicator purpose="subagent" />}
              <span className="truncate">{node.title}</span>
            </span>
          }
          icon={
            <span className="flex w-6 items-center justify-center" aria-hidden="true">
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
                  className={node.relationship === "home" ? "size-[18px]" : "size-5"}
                />
              )}
            </span>
          }
          description={
            hideRunningSubtitle ? undefined : (
              <span className="flex min-w-0 items-center gap-1.5 text-xs leading-none">
                <span className="min-w-0 flex-1 truncate" title={`${time} — ${relationship}`}>
                  {time}
                </span>
              </span>
            )
          }
          trailing={
            <div className="flex items-center">
              {node.relationship === "home" && rowProjectPath !== undefined && (
                <AutoMergeToggle projectPath={rowProjectPath} />
              )}
              <span
                className="flex size-6 shrink-0 items-center justify-center"
                data-slot="own-activity"
                aria-label={activity ? undefined : "Idle"}
                title={activity ? undefined : "Idle"}
              >
                <SessionActivityIndicator activity={activity} />
              </span>
            </div>
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
