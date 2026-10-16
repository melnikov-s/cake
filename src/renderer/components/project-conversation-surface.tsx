import { observer, useStore } from "r-state-tree/react";
import { Avatar } from "@/components/ui/avatar";
import { ErrorNotice } from "@/components/error-notice";
import { LoadingState } from "@/components/ui/loading-state";
import { ConversationSplitLayout } from "@/components/conversation-split-layout";
import { BlockingInterviews } from "@/components/blocking-interviews";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { ProjectComposerAccessory } from "./project-composer-accessory";
import { ProjectComposerHeader } from "./project-composer-header";
import { ProjectPaneHeader } from "./project-pane-header";
import { SessionArtifactPane } from "./session-artifact-pane";

export const ProjectConversationSurface = observer(function ProjectConversationSurface({
  browserMode,
}: {
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const projectOpen = store.projectOpenStore;
  const settings = root.settingsStore;
  const extensionUi = root.extensionUiStore;
  const sidebarCollapsed = !root.sidebarStore.visible;
  // Track pane focus here: changing it must refresh the split layout's chat props,
  // not only the independently observed pane headers.
  const focusedSessionId = root.sessionLayoutStore.focusedSessionId;
  const projectChatProps = (paneSession: ProjectSessionStore) => {
    const temporary = store.sessionRegistry.pendingSessions.isTemporary(paneSession.sessionId);
    const draft = store.sessionRegistry.pendingSessions.isDraft(paneSession.sessionId);
    const paneError =
      store.contextError(paneSession.sessionId) ??
      (paneSession.workspacePath === projectOpen.projectPath && projectOpen.error
        ? { message: projectOpen.error, details: projectOpen.errorDetails }
        : undefined) ??
      (paneSession.model.observationError
        ? { message: paneSession.model.observationError, details: undefined }
        : undefined);
    const focused = focusedSessionId === paneSession.sessionId;
    const errorMessage =
      paneError?.message ??
      paneSession.conversationSessionStore.composerStore.error ??
      paneSession.conversationSessionStore.configurationStore.error ??
      paneSession.interviewError?.error;
    const errorDetails = paneError
      ? paneError.details
      : (paneSession.conversationSessionStore.composerStore.errorDetails ??
        paneSession.conversationSessionStore.configurationStore.errorDetails ??
        paneSession.interviewError?.errorDetails);
    return {
      transcriptTransition: {
        requestedKey:
          store.openingSession?.sourceSessionId === paneSession.sessionId
            ? store.openingSession.sessionId
            : undefined,
        ready: paneSession.hydrated || temporary || draft || Boolean(paneError),
      },
      transcriptBehavior: projectTranscriptBehaviorFor(root, paneSession),
      empty: paneSession.hydrated ? (
        <div className="grid min-h-[calc(100vh-360px)] place-items-center content-center p-8 text-center">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            What should we build in{" "}
            <em>{root.projectCatalogStore.nameForPath(paneSession.workspacePath)}</em>?
          </h1>
          <p className="mt-3 max-w-[420px] text-sm leading-relaxed text-muted-foreground">
            Describe a task, ask a question, or choose another session from the sidebar.
          </p>
        </div>
      ) : paneError ? (
        <ErrorNotice
          title="Could not open session"
          message={paneError.message}
          details={paneError.details}
        />
      ) : (
        <LoadingState label="Opening session" />
      ),
      error:
        errorMessage && (paneSession.hydrated || !paneError)
          ? { message: errorMessage, details: errorDetails }
          : undefined,
      composerContent: root.sessionCatalogStore.find(paneSession.sessionId)
        ?.resolved ? undefined : (
        <BlockingInterviews session={paneSession} inlineWidgets={root.inlineWidgetStore} />
      ),
      composerLeadingAccessory: settings.appearance.sessionAvatarsEnabled
        ? { visible: true, content: <ProjectComposerAccessory session={paneSession} /> }
        : undefined,
      composerHeader: <ProjectComposerHeader session={paneSession} />,
      status:
        focused && extensionUi.statuses.length > 0 ? (
          <div
            className="mx-auto mt-1.5 flex w-full max-w-[51.25rem] gap-2.5 overflow-x-auto font-mono text-[10px] text-muted-foreground pointer-events-auto"
            role="status"
          >
            {extensionUi.statuses.map((status) => (
              <span key={status.key} className="whitespace-nowrap">
                <strong className="text-foreground">{status.key}</strong> {status.text}
              </span>
            ))}
          </div>
        ) : undefined,
    };
  };

  return (
    <ConversationSplitLayout
      store={root.sessionLayoutStore}
      findSession={(sessionId) => store.sessionRegistry.findSession(sessionId)}
      chatProps={projectChatProps}
      title={(sessionId) => root.sessionCatalogStore.find(sessionId)?.title ?? "New chat"}
      titleLeading={(sessionId) => {
        const summary = root.sessionCatalogStore.find(sessionId);
        const projectPath = summary?.projectPath ?? projectOpen.projectPath;
        const projectName = projectPath
          ? root.projectCatalogStore.nameForPath(projectPath)
          : projectOpen.projectName;
        return (
          <Avatar
            kind="project"
            seed={projectName}
            customIcon={
              projectPath ? root.projectCatalogStore.find(projectPath)?.settings.icon : undefined
            }
            className="size-5"
            title={projectName}
            aria-hidden="true"
          />
        );
      }}
      loadingLabel="Opening session"
      headerClassName={(pane) =>
        root.sessionLayoutStore.panes[0]?.paneId === pane.paneId
          ? cn("max-[620px]:pl-14", sidebarCollapsed && "pl-[124px]")
          : undefined
      }
      renderHeader={(pane, session) => (
        <ProjectPaneHeader pane={pane} session={session} browserMode={browserMode} />
      )}
      wrapPane={(session, children) => (
        <SessionArtifactPane sessionId={session.sessionId}>{children}</SessionArtifactPane>
      )}
      onFocus={(paneId) => root.navigationStore.focusSessionPane(paneId)}
      onSplit={(axis) => root.navigationStore.splitFocusedSession(axis)}
      onClose={(paneId) => root.navigationStore.closeSessionPane(paneId)}
    />
  );
});
