import { useState } from "react";
import { observer } from "r-state-tree/react";
import { SESSION_TITLE_MAX_LENGTH } from "../../contracts/conversations/session-contract";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { SidebarStore } from "../stores/SidebarStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import { Input } from "./ui/input";
import { SessionListItem, type SessionListItemProps } from "./ui/session-list-item";

export interface SidebarSessionItemProps extends Omit<
  SessionListItemProps,
  "activityTime" | "labelIds" | "availableLabels" | "renameInput" | "onContextMenu" | "onResolve"
> {
  store: SidebarStore;
  sessionMetadata?: SessionMetadataStore;
  session: SessionListItemProps["session"] & { workingDirectory?: string };
  onRename(sessionId: string, name: string): void;
  onResolve(sessionId: string, resolved: boolean): void;
  onDelete(sessionId: string): void;
  /** Omitted on surfaces without unread support; enables the context-menu toggle. */
  onMarkUnread?(sessionId: string, unread: boolean): void;
}

/** Sidebar behavior wraps the same session-row presentation used by destination pickers. */
export const SidebarSessionItem = observer(function SidebarSessionItem({
  store,
  sessionMetadata,
  onRename,
  onDelete,
  onMarkUnread,
  ...row
}: SidebarSessionItemProps) {
  const [renamingValue, setRenamingValue] = useState<string | null>(null);
  const { session, activity, resolved, onResolve } = row;
  const contextMenuUnread =
    onMarkUnread && !isActiveSessionActivity(activity) ? activity === "unread" : undefined;
  const isFamilyChild =
    Boolean(session.familyParentSessionId) && session.familyParentSessionId !== session.sessionId;
  const commitRename = () => {
    const value = renamingValue;
    setRenamingValue(null);
    if (!value) return;
    const name = value.trim();
    if (name) onRename(session.sessionId, name);
  };
  return (
    <SessionListItem
      {...row}
      activateOnMouseDown
      revealWhenSelected
      associated={store.isSessionAssociatedWithSelectedTodo(session.sessionId)}
      activityTime={store.sessionActivityTime(session.modifiedAt)}
      labelIds={sessionMetadata?.sessionLabelIds(session.sessionId) ?? []}
      availableLabels={sessionMetadata?.availableSessionLabels(session.sessionId) ?? []}
      renameInput={
        renamingValue === null ? undefined : (
          <Input
            size="sm"
            className="session-rename-input col-start-2 mr-2 w-[calc(100%-0.5rem)]"
            aria-label="Session name"
            value={renamingValue}
            maxLength={SESSION_TITLE_MAX_LENGTH}
            autoFocus
            onChange={(event) => setRenamingValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              else if (event.key === "Escape") setRenamingValue(null);
            }}
          />
        )
      }
      onContextMenu={(event) => {
        event.preventDefault();
        const { clientX, clientY } = event;
        requestAnimationFrame(() => {
          const menu = isFamilyChild
            ? store.showSessionContextMenu(
                session.sessionId,
                clientX,
                clientY,
                resolved,
                contextMenuUnread,
                true,
              )
            : store.showSessionContextMenu(
                session.sessionId,
                clientX,
                clientY,
                resolved,
                contextMenuUnread,
              );
          void menu.then((action) => {
            if (action?.action === "rename") setRenamingValue(session.title);
            else if (action?.action === "mark-unread") onMarkUnread?.(session.sessionId, true);
            else if (action?.action === "resolve") onResolve(session.sessionId, true);
            else if (action?.action === "unresolve") onResolve(session.sessionId, false);
            else if (action?.action === "delete" && !isFamilyChild) onDelete(session.sessionId);
          });
        });
      }}
    />
  );
});
