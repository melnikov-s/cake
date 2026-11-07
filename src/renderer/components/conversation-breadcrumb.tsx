import { Fragment } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
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
  const projectPath =
    root.sessionCatalogStore.find(sessionId)?.projectPath ??
    root.cakeChatCollectionStore.summaries.find((chat) => chat.sessionId === sessionId)
      ?.projectPath;
  const lineage = navigator
    .lineageFor(sessionId)
    .filter(
      (node) =>
        node.relationship !== "home" &&
        (node.target.kind !== "cake-chat" || node.target.sessionId !== CAKE_CHAT_SESSION_ID),
    );
  return (
    <div className="flex w-full min-w-0 items-start py-[calc((var(--title-bar-height)-24px)/2)]">
      <nav
        aria-label="Conversation breadcrumb"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 text-xs leading-5"
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1 text-xs font-normal text-muted-foreground [app-region:no-drag]"
          aria-current={!projectPath && lineage.length === 0 ? "page" : undefined}
          onClick={() => {
            root.appShellStore.recordConversationInteraction({
              kind: "cake-chat",
              sessionId: CAKE_CHAT_SESSION_ID,
            });
            void root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID);
          }}
        >
          Cake Chat
        </Button>
        {projectPath && (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 max-w-full px-1 text-xs font-normal text-muted-foreground [app-region:no-drag]"
              title={projectPath}
              aria-current={lineage.length === 0 ? "page" : undefined}
              onClick={() => void root.navigationStore.openProjectChat(projectPath)}
            >
              {root.projectCatalogStore.nameForPath(projectPath)}
            </Button>
          </>
        )}
        {lineage.map((node, index) => (
          <Fragment key={node.key}>
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-auto min-h-6 max-w-full whitespace-normal break-words px-1 py-0.5 text-left text-xs font-normal text-muted-foreground [app-region:no-drag]",
                index === lineage.length - 1 && "font-medium text-foreground",
              )}
              title={node.title}
              aria-current={index === lineage.length - 1 ? "page" : undefined}
              onClick={() => void navigator.open(node)}
            >
              {node.title}
            </Button>
          </Fragment>
        ))}
      </nav>
    </div>
  );
});
