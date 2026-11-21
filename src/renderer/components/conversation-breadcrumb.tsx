import { Fragment } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { SessionPurposeIndicator } from "./ui/session-purpose-indicator";
import { cn } from "../lib/utils";

/** Persistent, navigable ownership lineage; grouping never claims Session Family ancestry. */
export const ConversationBreadcrumb = observer(function ConversationBreadcrumb({
  sessionId,
  subagentHandleId,
  ariaLabel = "Conversation breadcrumb",
  includeChatTitle = false,
}: {
  sessionId: string;
  subagentHandleId?: string;
  ariaLabel?: string;
  /** The dock identifies its displayed primary chat, even while a secondary chat is selected. */
  includeChatTitle?: boolean;
}) {
  const root = useStore(RootStore);
  const navigator = root.conversationNavigatorStore;
  const previewTitle = root.sessionRegistry.forkPreviewTitle(sessionId);
  const chat = isCakeChatSessionId(sessionId)
    ? root.cakeChatCollectionStore.summaries.find((summary) => summary.sessionId === sessionId)
    : undefined;
  const projectPath = navigator.projectPathForSession(sessionId) ?? chat?.projectPath;
  const lineage = (
    subagentHandleId
      ? navigator.lineageForTarget({ kind: "subagent", sessionId, handleId: subagentHandleId })
      : includeChatTitle
        ? navigator.lineageForTarget({
            kind: isCakeChatSessionId(sessionId) ? "cake-chat" : "project-session",
            sessionId,
          })
        : navigator.lineageFor(sessionId)
  ).filter(
    (node) =>
      node.relationship !== "home" &&
      (node.target.kind !== "cake-chat" || node.target.sessionId !== CAKE_CHAT_SESSION_ID),
  );
  const homeTitle = projectPath ? root.projectCatalogStore.nameForPath(projectPath) : "Cake Chat";
  const currentTitle =
    previewTitle ??
    (includeChatTitle && lineage.length === 0 && chat?.title !== homeTitle
      ? chat?.title
      : undefined);
  return (
    <div className="flex h-full w-full min-w-0 items-center">
      <nav
        aria-label={ariaLabel}
        className="flex h-full min-w-0 flex-1 items-center gap-x-0.5 overflow-hidden text-xs leading-5"
      >
        {!projectPath ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1 text-xs font-normal text-muted-foreground [app-region:no-drag]"
            aria-current={
              !projectPath && lineage.length === 0 && !currentTitle ? "page" : undefined
            }
            onClick={() => {
              root.appShellStore.recordConversationInteraction({
                kind: "cake-chat",
                sessionId: CAKE_CHAT_SESSION_ID,
              });
              void root.navigationStore.openGlobalChat();
            }}
          >
            <span className="truncate">Cake Chat</span>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              // With a title after it, the project crumb gives up its name first, down to its
              // artwork, so the title stays readable in a narrow window.
              // Only colors animate: the crumb's width changes with the title beside it.
              "h-6 justify-start gap-2 px-1 text-xs font-normal text-muted-foreground transition-colors [app-region:no-drag]",
              lineage.length > 0 || currentTitle
                ? "min-w-[26px] max-w-1/2 shrink-[1000]"
                : "min-w-0 max-w-full shrink-0",
            )}
            title={projectPath}
            aria-current={lineage.length === 0 && !currentTitle ? "page" : undefined}
            onClick={() => void root.navigationStore.openProjectChat(projectPath)}
          >
            <Avatar
              kind="project"
              seed={root.projectCatalogStore.nameForPath(projectPath)}
              customIcon={root.projectCatalogStore.find(projectPath)?.settings?.icon}
              className="size-[18px]"
              aria-hidden="true"
            />
            <span className="truncate">{root.projectCatalogStore.nameForPath(projectPath)}</span>
          </Button>
        )}
        {currentTitle && (
          <>
            <span aria-hidden="true" className="shrink-0 text-muted-foreground">
              ›
            </span>
            <span
              aria-current="page"
              className="min-w-0 truncate px-1 font-bold text-foreground"
              title={currentTitle}
            >
              {currentTitle}
            </span>
          </>
        )}
        {lineage.map((node, index) => (
          <Fragment key={node.key}>
            <span aria-hidden="true" className="shrink-0 text-muted-foreground">
              ›
            </span>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                // Titles start at their full width and shrink after the project crumb; the
                // current (last) title gives up space before the ancestors that lead to it.
                "h-6 min-w-0 max-w-fit flex-auto px-1 text-xs font-normal text-muted-foreground transition-colors [app-region:no-drag]",
                index === lineage.length - 1 ? "font-bold text-foreground" : "shrink-[0.05]",
              )}
              title={node.title}
              aria-current={index === lineage.length - 1 ? "page" : undefined}
              onClick={() => void navigator.open(node)}
            >
              {(node.target.kind === "project-session" || node.target.kind === "subagent") && (
                <span aria-hidden="true" className="me-1 inline-flex shrink-0">
                  <SessionPurposeIndicator
                    purpose={
                      node.target.kind === "subagent"
                        ? "subagent"
                        : (root.sessionCatalogStore.sessionPurpose(node.target.sessionId) ?? "user")
                    }
                  />
                </span>
              )}
              <span className="truncate">{node.title}</span>
            </Button>
          </Fragment>
        ))}
      </nav>
    </div>
  );
});
