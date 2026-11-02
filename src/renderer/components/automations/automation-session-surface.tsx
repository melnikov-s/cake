import { observer, StoreProvider, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Chat } from "../chat";
import { Button } from "../ui/button";
import { RepeatIcon } from "../ui/icons";
import { Callout } from "../ui/callout";
import { LoadingState } from "../ui/loading-state";

export const AutomationSessionSurface = observer(function AutomationSessionSurface() {
  const root = useStore(RootStore);
  const session = root.automationSessionsStore.selectedSession;
  if (!session)
    return (
      <div className="p-8">
        <LoadingState label="Opening automation run" />
      </div>
    );
  const summary = root.props.projection.automations.unresolvedSessions.find(
    (item) => item.sessionId === session.sessionId,
  );
  const busy = summary?.running || session.model.streaming;
  return (
    <StoreProvider store={session}>
      <div className="flex h-full min-h-0 flex-col" data-slot="automation-session">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/65 px-8 py-3 text-xs">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-full border border-border/75 bg-muted px-2 py-1">
              <RepeatIcon />
              Automation Session
            </span>
            <span className="text-muted-foreground">
              {session.identity.context._tag === "Global"
                ? "Global"
                : root.projectCatalogStore.nameForPath(session.identity.context.projectPath)}
            </span>
            <span>{busy ? "Running" : session.resolved ? "Resolved" : "Needs review"}</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void root.navigationStore.editAutomation(session.identity.automationId)
              }
            >
              Automation
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || session.lifecyclePending}
              onClick={() => void session.setResolved(!session.resolved)}
            >
              {session.resolved ? "Unresolve" : "Resolve"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void session.setUnread(!summary?.unread)}
            >
              {summary?.unread ? "Mark read" : "Mark unread"}
            </Button>
          </div>
        </header>
        {(session.error || session.model.observationError) && (
          <Callout variant="error" role="alert" className="mx-8 mt-4">
            {session.error ?? session.model.observationError}
          </Callout>
        )}
        <div className="min-h-0 flex-1">
          <Chat
            store={session.conversationSessionStore.chatStore}
            composerFocusEnabled={!session.resolved}
            transcriptTransition={{ ready: Boolean(session.model.sessionFile) }}
            transcriptBehavior={{
              workspacePath: session.identity.workingDirectory,
              messageReferenceSessionId: session.sessionId,
              inlineWidgets: root.inlineWidgetStore,
              inlineArtifactPreviews: root.inlineArtifactPreviewStore,
            }}
            empty={
              session.model.observedSnapshotRevision === 0 ? (
                <div className="p-8">
                  <LoadingState label="Opening automation run" />
                </div>
              ) : undefined
            }
          />
        </div>
      </div>
    </StoreProvider>
  );
});
