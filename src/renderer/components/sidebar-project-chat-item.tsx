import { observer } from "r-state-tree/react";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import type { CakeChatSummaryProjection } from "../stores/CakeChatPendingSessionsStore";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { AppShellStore } from "../stores/AppShellStore";
import { NavItem } from "./ui/nav-item";
import { CakeIcon } from "./ui/icons";
import { SessionActivityIndicator } from "./session-activity-indicator";

/** Project Chat conversation entry in chronological navigation. */
export const SidebarProjectChatItem = observer(function SidebarProjectChatItem({
  summary,
  cakeChat,
  shell,
  now,
  onOpen,
}: {
  summary: CakeChatSummaryProjection;
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
      description={`Project Chat · ${formatRelativeSessionTime(summary.modifiedAt, now)}`}
      icon={<CakeIcon aria-hidden />}
      active={selected}
      className="text-[13px] [&_[data-slot=icon]]:size-4"
      trailing={activity && <SessionActivityIndicator activity={activity} selected={selected} />}
      onClick={() => onOpen(summary.sessionId)}
      onContextMenu={(event) => {
        event.preventDefault();
        void cakeChat.showContextMenu(event.clientX, event.clientY, summary.sessionId);
      }}
    />
  );
});
