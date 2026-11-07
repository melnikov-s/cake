import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ConversationNavigatorRow } from "./conversation-navigator-row";
import { Button } from "./ui/button";
import { ChevronIcon, PlusIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { SearchInput } from "./ui/search-input";

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
  const resolvedRows = resolvedExpanded ? store.rows(projectPath, true) : [];
  const home = tree.roots.find((node) => node.relationship === "home");
  const activeExpanded = !home || store.isExpanded(projectPath, home.key);
  const activeHasMore = projectPath
    ? list.projectSessions(projectPath).length > list.visibleProjectSessions(projectPath).length
    : false;
  const resolvedHasMore = projectPath
    ? list.hasMoreResolvedProjectSessions(projectPath)
    : list.hasMoreResolvedCakeChatSessions;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Sessions">
      <div className="mx-2 mb-2 flex min-w-0 items-center gap-1">
        <SearchInput
          className="min-w-0 flex-1"
          label="Search sessions"
          placeholder="Search sessions…"
          value={query}
          onValueChange={(query) => store.setQuery(projectPath, query)}
        />
        <IconButton
          tooltip="New Session"
          hotkey="new-session"
          onClick={() => root.newSessionStore.show()}
        >
          <PlusIcon />
        </IconButton>
      </div>
      <div className="mx-3 mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{tree.total} total</span>
        {tree.running > 0 && <span>{tree.running} running</span>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-1 text-xs text-muted-foreground"
          onClick={() => store.collapseAll(projectPath)}
        >
          Collapse all
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-3"
        aria-label="Session conversations"
      >
        <section aria-label="Active sessions">
          {rows.map(({ node, depth }) => (
            <ConversationNavigatorRow
              key={node.key}
              node={node}
              depth={depth}
              projectPath={projectPath}
            />
          ))}
          {rows.length === 0 && (
            <p role="status" className="px-2 py-4 text-sm text-muted-foreground">
              {query.trim() ? "No matching conversations" : "No sessions"}
            </p>
          )}
          {activeExpanded && activeHasMore && !query.trim() && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => list.showMoreSessions(scope)}
            >
              Show more
            </Button>
          )}
        </section>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start gap-1 text-muted-foreground"
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
            {resolvedRows.map(({ node, depth }) => (
              <ConversationNavigatorRow
                key={node.key}
                node={node}
                depth={depth}
                projectPath={projectPath}
              />
            ))}
            {resolvedHasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => list.showMoreSessions(scope, true)}
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
