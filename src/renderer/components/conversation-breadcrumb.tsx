import { Fragment } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { HomeIcon } from "./ui/icons";
import { cn } from "../lib/utils";
import { formatHotkey } from "../lib/hotkeys";

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
  const lineage = navigator.lineageFor(sessionId);
  return (
    <div className="flex w-full min-w-0 items-start gap-2 [app-region:no-drag]">
      <nav
        aria-label="Conversation breadcrumb"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 text-xs leading-5"
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1 text-xs font-normal text-muted-foreground"
          onClick={() => void root.navigationStore.returnToProjectChat()}
        >
          Cake home
        </Button>
        {projectPath && (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 max-w-full px-1 text-xs font-normal text-muted-foreground"
              title={projectPath}
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
                "h-auto min-h-6 max-w-full whitespace-normal break-words px-1 py-0.5 text-left text-xs font-normal text-muted-foreground",
                index === lineage.length - 1 && "font-medium text-foreground",
              )}
              title={node.title}
              aria-current={index === lineage.length - 1 ? "page" : undefined}
              onClick={() => void navigator.open(node)}
            >
              {node.relationship === "home"
                ? projectPath
                  ? "Project Chat"
                  : "Cake Chat"
                : node.title}
            </Button>
          </Fragment>
        ))}
      </nav>
      <span className="flex shrink-0 items-center gap-1">
        <IconButton
          tooltip={projectPath ? "Return to Project Chat" : "Return to Cake Chat"}
          ariaLabel={projectPath ? "Return to Project Chat" : "Return to Cake Chat"}
          hotkey="return-to-project-chat"
          className="shrink-0"
          onClick={() => void root.navigationStore.returnToProjectChat()}
        >
          <HomeIcon />
        </IconButton>
        <span className="text-xs leading-7 text-muted-foreground">
          {formatHotkey(root.settingsStore.hotkeys.bindingFor("return-to-project-chat"))}
        </span>
      </span>
    </div>
  );
});
