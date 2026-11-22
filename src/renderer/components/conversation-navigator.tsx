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
  const activeHasMore = !query.trim() && store.hasMoreSessions(projectPath);
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
        <section aria-label="Projects">
          {groups.map(({ path, name, home, headingKey, expanded, active, archive }) => (
            <section key={path} aria-label={name} data-project-path={path}>
              {home ? (
                <ConversationNavigatorRow node={home.node} depth={0} projectPath={projectPath} />
              ) : store.isPinnedOpen(projectPath, headingKey) ? (
                <h3 className="px-2 py-2 text-sm font-medium">{name}</h3>
              ) : (
                <ConversationNavigatorGroupHeader
                  label={name}
                  expanded={expanded}
                  onToggle={() => store.toggleExpanded(projectPath, headingKey)}
                />
              )}
              <div>
                {active.map(({ kind, label, count, expanded, running, autoMerge, rows }) => (
                  <section key={kind} aria-label={label} data-project-path={path}>
                    <ConversationNavigatorGroupHeader
                      label={label}
                      count={count}
                      expanded={expanded}
                      collapsedSummary={
                        running === undefined
                          ? undefined
                          : `${count} delegated · ${running} running`
                      }
                      hiddenActivity={
                        kind === "user" && !expanded
                          ? list.sessionKindGroupActivity(path, kind)
                          : undefined
                      }
                      actions={autoMerge && <AutoMergeToggle projectPath={path} />}
                      onToggle={() => store.toggleKind(projectPath, path, kind, expanded)}
                    />
                    {rows.map(({ node, depth }) => (
                      <ConversationNavigatorRow
                        key={node.key}
                        node={node}
                        depth={depth}
                        containingProjectPath={home ? path : undefined}
                        projectPath={projectPath}
                      />
                    ))}
                  </section>
                ))}
                {archive && (
                  <>
                    <ConversationNavigatorGroupHeader
                      label="Resolved sessions"
                      count={archive.count}
                      expanded={archive.expanded}
                      onToggle={() => list.setArchiveExpanded(path, !archive.expanded)}
                    />
                    {archive.expanded && (
                      <section aria-label="Resolved sessions">
                        {archive.rows.map(({ node, depth }) => (
                          <ConversationNavigatorRow
                            key={node.key}
                            node={node}
                            depth={depth}
                            containingProjectPath={home ? path : undefined}
                            projectPath={projectPath}
                          />
                        ))}
                        {archive.hasMore && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-muted-foreground"
                            onClick={() => list.showMoreSessions(path, true)}
                          >
                            Show more
                          </Button>
                        )}
                      </section>
                    )}
                  </>
                )}
              </div>
            </section>
          ))}
          {groups.length === 0 && (
            <p role="status" className="px-2 py-4 text-sm text-muted-foreground">
              {query.trim() ? "No matching conversations" : "No sessions"}
            </p>
          )}
          {activeHasMore && (
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
        {store.error && (
          <p role="alert" className="px-2 py-2 text-xs text-destructive">
            {store.error}
          </p>
        )}
      </div>
    </section>
  );
});
