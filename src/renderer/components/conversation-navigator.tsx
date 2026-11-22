import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ConversationNavigatorRow } from "./conversation-navigator-row";
import { Button } from "./ui/button";
import { PlusIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { ConversationNavigatorSearch } from "./conversation-navigator-search";
import { ConversationNavigatorGroupHeader } from "./conversation-navigator-group-header";
import { AutoMergeToggle, canShowAutoMerge } from "./auto-merge-toggle";

/** All-project Sessions source list, prioritized by the focused project. */
export const ConversationNavigator = observer(function ConversationNavigator({
  projectPath,
}: {
  projectPath: string | undefined;
}) {
  const root = useStore(RootStore);
  const store = root.conversationNavigatorStore;
  const list = root.sidebarStore.sessionListStore;
  const query = store.query(projectPath);
  const groups = store.rowGroups(projectPath, (path) =>
    canShowAutoMerge(root.projectCatalogStore.find(path)),
  );
  const scope = projectPath ?? "cake-chat";
  const resolvedExpanded = list.resolvedGroupExpanded;
  const activeHasMore = store.hasMoreSessions(projectPath);
  const resolvedHasMore = store.hasMoreSessions(projectPath, true);
  const resolvedCount = store.resolvedCount();
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Sessions">
      <div className="flex min-w-0 items-center gap-1.5 px-3.5 pt-3 pb-2">
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
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3"
        aria-label="Session conversations"
      >
        <section aria-label="Active sessions">
          {groups.map(({ key, containingProjectPath, showEmptyDelegatedGroup, header, rows }) => (
            <section key={key} aria-label={header?.label} data-project-path={header?.projectPath}>
              {header && (
                <ConversationNavigatorGroupHeader
                  label={header.label}
                  count={header.count}
                  expanded={header.expanded}
                  collapsedSummary={
                    header.running === undefined
                      ? undefined
                      : `${header.count} delegated · ${header.running} running`
                  }
                  hiddenActivity={
                    header.kind === "user" && !header.expanded
                      ? list.sessionKindGroupActivity(header.projectPath, header.kind)
                      : undefined
                  }
                  actions={header.autoMerge && <AutoMergeToggle projectPath={header.projectPath} />}
                  onToggle={() =>
                    store.toggleKind(projectPath, header.projectPath, header.kind, header.expanded)
                  }
                />
              )}
              {rows.map(({ node, depth }) => (
                <ConversationNavigatorRow
                  key={node.key}
                  node={node}
                  depth={depth}
                  containingProjectPath={containingProjectPath}
                  hasGroupedContent={showEmptyDelegatedGroup}
                  projectPath={projectPath}
                />
              ))}
            </section>
          ))}
          {groups.length === 0 && (
            <p role="status" className="px-2 py-4 text-sm text-muted-foreground">
              {query.trim() ? "No matching conversations" : "No sessions"}
            </p>
          )}
          {activeHasMore && !query.trim() && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => store.showMoreSessions()}
            >
              Show more
            </Button>
          )}
        </section>
        {(resolvedExpanded || resolvedCount !== 0) && (
          <ConversationNavigatorGroupHeader
            label="Resolved sessions"
            count={resolvedCount}
            expanded={resolvedExpanded}
            onToggle={() => list.toggleResolvedGroupExpanded()}
          />
        )}
        {resolvedExpanded && resolvedCount !== 0 && (
          <section aria-label="Resolved sessions">
            {store.resolvedRows(projectPath).map(({ node, depth }) => (
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
                onClick={() => store.showMoreSessions(true)}
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
