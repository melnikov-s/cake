import { observer } from "r-state-tree/react";
import type { ProjectIcon } from "../../contracts/application/application-data";
import { isActiveSessionActivity } from "../lib/session-activity";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import type { CakeChatSummaryProjection } from "../stores/CakeChatPendingSessionsStore";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { AppShellStore } from "../stores/AppShellStore";
import { Avatar } from "./ui/avatar";
import { NavItem } from "./ui/nav-item";
import { CakeIcon } from "./ui/icons";
import { SessionActivityIndicator } from "./session-activity-indicator";

/** Project Chat conversation entry in chronological navigation. */
export const SidebarProjectChatItem = observer(function SidebarProjectChatItem({
  summary,
  project,
  cakeChat,
  shell,
  now,
  onOpen,
}: {
  summary: CakeChatSummaryProjection;
  /** The owning Project's avatar, as shown beside its name on Project Session rows. */
  project?: { name: string; customIcon?: ProjectIcon; showAvatar: boolean };
  cakeChat: CakeChatCollectionStore;
  shell: AppShellStore;
  now: number;
  onOpen(sessionId: string): void;
}) {
  const selected =
    shell.selection.kind === "cake-chat" && shell.selection.sessionId === summary.sessionId;
  const activity = cakeChat.activityFor(summary.sessionId);
  return (
    <NavItem
      data-slot="project-chat-item"
      data-session-id={summary.sessionId}
      data-animated-list-key={summary.sessionId}
      label={summary.title}
      description={
        isActiveSessionActivity(activity)
          ? "Project Chat"
          : `Project Chat · ${formatRelativeSessionTime(summary.modifiedAt, now)}`
      }
      // Mirror session rows: a 1.5rem leading column flush with the row edge
      // and a centered w-8 status column inside the px-2 inset.
      icon={
        <span
          data-slot="project-chat-leading"
          className="flex w-6 items-center justify-center [&_[data-slot=icon]]:size-4"
        >
          {project?.showAvatar ? (
            <Avatar
              kind="project"
              seed={project.name}
              customIcon={project.customIcon}
              className="size-4"
              aria-hidden="true"
            />
          ) : (
            <CakeIcon aria-hidden />
          )}
        </span>
      }
      active={selected}
      className="pl-0 text-[13px]"
      trailing={
        activity && (
          <span data-slot="project-chat-status" className="flex w-8 items-center justify-center">
            <SessionActivityIndicator activity={activity} />
          </span>
        )
      }
      onClick={() => onOpen(summary.sessionId)}
      onContextMenu={(event) => {
        event.preventDefault();
        void cakeChat.showContextMenu(event.clientX, event.clientY, summary.sessionId);
      }}
    />
  );
});
