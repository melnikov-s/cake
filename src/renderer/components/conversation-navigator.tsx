import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ConversationNavigatorRow } from "./conversation-navigator-row";
import { Button } from "./ui/button";
import { ChevronIcon, PlusIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { ConversationNavigatorSearch } from "./conversation-navigator-search";

/** Scoped recursive Sessions source-list. Project utilities remain in the persistent rail. */
export const ConversationNavigator = observer(function ConversationNavigator({
  projectPath,
}: {
  projectPath: string | undefined;
}) {
  const root = useStore(RootStore);
  const store = root.conversationNavigatorStore;
  const list = root.sidebarStore.sessionListStore;
  const tree = store.tree(projectPath);
  const query = store.query(projectPath);
  const rows = store.rows(projectPath);
  const scope = projectPath ?? "cake-chat";
  const resolvedExpanded = list.isResolvedGroupExpanded(scope);
  // Flattened rows are parent-first. Only a visible project heading supplies identity
  // to its descendants; ungrouped global rows (including resolved history) still need a badge.
  const containingProjects = new Map<string, string>();
  for (const { node } of rows) {
    const path =
      node.relationship === "home"
        ? root.cakeChatCatalogModel.sessions.find(
            (chat) => chat.sessionId === node.target.sessionId,
          )?.projectPath
        : node.parentKey
          ? containingProjects.get(node.parentKey)
          : undefined;
    if (path !== undefined) containingProjects.set(node.key, path);
  }
  const home = tree.roots.find((node) => node.relationship === "home");
  const activeHasMore = store.hasMoreSessions(projectPath);
  const resolvedHasMore = store.hasMoreSessions(projectPath, true);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Sessions">
      <div className="mx-2 my-2 flex min-w-0 items-center gap-1">
        <ConversationNavigatorSearch key={scope} projectPath={projectPath} />
        <IconButton
          tooltip={
            projectPath ? "New session in this project" : "Choose destination for new session"
          }
          onClick={() => {
            if (projectPath) void root.navigationStore.createSession(projectPath);
            else root.newSessionStore.show();
          }}
        >
          <PlusIcon />
        </IconButton>
      </div>
      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-3"
        aria-label="Session conversations"
      >
        <section aria-label="Active sessions">
          {store.rowGroups(projectPath).map((group, index) => (
            <section key={index} aria-label={group.label}>
              {group.label && (
                <h3 className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                  {group.label}
                </h3>
              )}
              {group.rows.map(({ node, depth }) => (
                <ConversationNavigatorRow
                  key={node.key}
                  node={node}
                  depth={depth}
                  hideHomeRail={home?.label === "Project Chat"}
                  containingProjectPath={containingProjects.get(node.key)}
                  projectPath={projectPath}
                />
              ))}
            </section>
          ))}
          {rows.length === 0 && (
            <p role="status" className="px-2 py-4 text-sm text-muted-foreground">
              {query.trim() ? "No matching conversations" : "No sessions"}
            </p>
          )}
          {activeHasMore && !query.trim() && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => store.showMoreSessions(projectPath)}
            >
              Show more
            </Button>
          )}
        </section>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start gap-1 text-muted-foreground"
          iconSize="inline"
          aria-expanded={resolvedExpanded}
          onClick={() => list.toggleResolvedGroupExpanded(scope)}
        >
          <span className={resolvedExpanded ? undefined : "-rotate-90"}>
            <ChevronIcon />
          </span>
          Resolved sessions
        </Button>
        {resolvedExpanded && (
          <section aria-label="Resolved sessions">
            {store.rowGroups(projectPath, true).map((group, index) => (
              <section key={index} aria-label={group.label}>
                {group.label && (
                  <h3 className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </h3>
                )}
                {group.rows.map(({ node, depth }) => (
                  <ConversationNavigatorRow
                    key={node.key}
                    node={node}
                    depth={depth}
                    projectPath={projectPath}
                  />
                ))}
              </section>
            ))}
            {resolvedHasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => store.showMoreSessions(projectPath, true)}
              >
                Show more
              </Button>
            )}
          </section>
        )}
        {store.error && (
          <p role="alert" className="px-2 py-2 text-xs text-destructive">
            {store.error}
          </p>
        )}
      </div>
    </section>
  );
});
