import { Fragment } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

/** Persistent, navigable ownership lineage; grouping never claims Session Family ancestry. */
export const ConversationBreadcrumb = observer(function ConversationBreadcrumb({
  sessionId,
}: {
  sessionId: string;
}) {
  const root = useStore(RootStore);
  const navigator = root.conversationNavigatorStore;
  const previewTitle = root.sessionRegistry.forkPreviewTitle(sessionId);
  const previewDirectory = previewTitle
    ? root.sessionRegistry.findSession(sessionId)?.workspacePath
    : undefined;
  const projectPath =
    root.sessionCatalogStore.find(sessionId)?.projectPath ??
    root.cakeChatCollectionStore.summaries.find((chat) => chat.sessionId === sessionId)
      ?.projectPath ??
    (previewDirectory ? root.sessionCatalogStore.projectPathFor(previewDirectory) : undefined);
  const lineage = navigator
    .lineageFor(sessionId)
    .filter(
      (node) =>
        node.relationship !== "home" &&
        (node.target.kind !== "cake-chat" || node.target.sessionId !== CAKE_CHAT_SESSION_ID),
    );
  return (
    <div className="flex h-full w-full min-w-0 items-center">
      <nav
        aria-label="Conversation breadcrumb"
        className="flex h-full min-w-0 flex-1 items-center gap-x-0.5 overflow-hidden text-xs leading-5"
      >
        {!projectPath ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1 text-xs font-normal text-muted-foreground [app-region:no-drag]"
            aria-current={!projectPath && lineage.length === 0 ? "page" : undefined}
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
              "h-6 min-w-0 shrink-0 justify-start gap-2 px-1 text-xs font-normal text-muted-foreground [app-region:no-drag]",
              lineage.length > 0 || previewTitle ? "max-w-1/2" : "max-w-full",
            )}
            title={projectPath}
            aria-current={lineage.length === 0 && !previewTitle ? "page" : undefined}
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
        {previewTitle && (
          <>
            <span aria-hidden="true" className="shrink-0 text-muted-foreground">
              ›
            </span>
            <span
              aria-current="page"
              className="min-w-0 truncate px-1 font-bold text-foreground"
              title={previewTitle}
            >
              {previewTitle}
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
                "h-6 min-w-0 max-w-fit flex-1 px-1 text-xs font-normal text-muted-foreground [app-region:no-drag]",
                index === lineage.length - 1 && "font-bold text-foreground",
              )}
              title={node.title}
              aria-current={index === lineage.length - 1 ? "page" : undefined}
              onClick={() => void navigator.open(node)}
            >
              <span className="truncate">{node.title}</span>
            </Button>
          </Fragment>
        ))}
      </nav>
    </div>
  );
});
