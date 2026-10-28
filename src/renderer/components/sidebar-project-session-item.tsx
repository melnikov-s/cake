import { observer } from "r-state-tree/react";
import type { SidebarProjectGroupProps } from "./sidebar-project-group";
import { SidebarSessionItem } from "./sidebar-session-item";

type Props = Pick<
  SidebarProjectGroupProps,
  | "store"
  | "sessionList"
  | "sessionMetadata"
  | "appearance"
  | "focusMode"
  | "resolved"
  | "onOpenSession"
> & {
  session: ReturnType<SidebarProjectGroupProps["sessionList"]["projectSessions"]>[number];
  selected: boolean;
  paneNumber?: number;
};

/** Keep row metadata and action closures out of the Project's selection render. */
export const SidebarProjectSessionItem = observer(function SidebarProjectSessionItem({
  store,
  sessionList,
  sessionMetadata,
  appearance,
  focusMode,
  resolved,
  onOpenSession,
  session,
  selected,
  paneNumber,
}: Props) {
  return (
    <SidebarSessionItem
      store={store}
      sessionMetadata={sessionMetadata}
      session={session}
      managedWorktree={store.managedWorktree(session.workingDirectory)}
      selected={selected}
      paneNumber={paneNumber}
      resolved={resolved}
      activity={sessionList.sessionActivityForDisplay(session)}
      labels={sessionMetadata.sessionLabels(session.sessionId)}
      avatarSeed={session.sessionId}
      avatarsEnabled={appearance.sessionAvatarsEnabled}
      charactersEnabled={appearance.sidebarCharactersEnabled}
      focusMode={focusMode}
      onOpen={onOpenSession}
      onToggleFamily={(sessionId) => sessionList.toggleFamilyCollapsed(sessionId)}
      familyCollapsed={sessionList.isFamilyCollapsed(session.sessionId)}
      onRename={(sessionId, name) => void store.renameSession(sessionId, name)}
      onResolve={(sessionId, nextResolved) =>
        void store.setSessionResolved(sessionId, nextResolved)
      }
      onSetLabels={(sessionId, labelIds) => void store.setSessionLabels(sessionId, labelIds)}
      onDelete={(sessionId) => void store.deleteSession(sessionId)}
      onMarkUnread={(sessionId, unread) => void store.setSessionUnread(sessionId, unread)}
    />
  );
});
