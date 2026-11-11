import { observer, useStore } from "r-state-tree/react";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { ConversationBreadcrumb } from "./conversation-breadcrumb";
import { ErrorNotice } from "@/components/error-notice";
import { LoadingState } from "@/components/ui/loading-state";
import { FocusedConversationLayout } from "@/components/focused-conversation-layout";
import { BlockingInterviews } from "@/components/blocking-interviews";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { ProjectComposerAccessory } from "./project-composer-accessory";
import { ProjectComposerHeader } from "./project-composer-header";
import { ProjectPaneHeader } from "./project-pane-header";
import { SessionForkStatus } from "./session-fork-status";
import { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { CakeChatPaneHeader } from "./cake-chat-pane-header";
import { ProjectTodoSelectionBar } from "./project-todo-selection-bar";
import { chatWidgetsFor } from "../lib/chat-widgets";
import { cakeChatPropsFor } from "../lib/cake-chat-props";

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
  // Observe selection here so conversation-specific composer and status props refresh.
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
      paneSession.conversationSessionStore.interviewStore.error?.error;
    const errorDetails = paneError
      ? paneError.details
      : (paneSession.conversationSessionStore.composerStore.errorDetails ??
        paneSession.conversationSessionStore.configurationStore.errorDetails ??
        paneSession.conversationSessionStore.interviewStore.error?.errorDetails);
    return {
      widgets: paneSession.isForkPreview
        ? undefined
        : chatWidgetsFor(root, { sessionId: paneSession.sessionId, kind: "project-session" }),
      transcriptTransition: {
        contentKey: paneSession.transcriptContinuityKey ?? paneSession.sessionId,
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
        <BlockingInterviews
          interviews={paneSession.conversationSessionStore.interviewStore.interviews}
          parts={paneSession.canonicalParts}
          inlineWidgets={root.inlineWidgetStore}
        />
      ),
      composerLeadingAccessory:
        settings.appearance.sessionAvatarsEnabled && !paneSession.isForkPreview
          ? { visible: true, content: <ProjectComposerAccessory session={paneSession} /> }
          : undefined,
      composerHeader: paneSession.isForkPreview ? (
        <SessionForkStatus store={store.sessionContinuationStore} />
      ) : (
        <ProjectComposerHeader session={paneSession} />
      ),
      status:
        focused && extensionUi.statuses.length > 0 ? (
          <div
            className="mx-auto mt-1.5 flex w-full max-w-[51.25rem] gap-2.5 overflow-x-auto font-mono text-xs text-muted-foreground pointer-events-auto"
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
    <FocusedConversationLayout
      store={root.sessionLayoutStore}
      findSession={(sessionId) =>
        root.cakeChatCollectionStore.registry.find(sessionId) ??
        store.sessionRegistry.findSession(sessionId)
      }
      chatProps={(session) =>
        session instanceof CakeChatSessionStore
          ? cakeChatPropsFor(root, session)
          : projectChatProps(session)
      }
      wrapPane={(session, conversation) =>
        session instanceof CakeChatSessionStore ? (
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <ProjectTodoSelectionBar todos={session.todos} />
            <div className="min-h-0 flex-1">{conversation}</div>
          </div>
        ) : (
          conversation
        )
      }
      title={(sessionId) =>
        root.conversationNavigatorStore.lineageFor(sessionId).at(-1)?.title ??
        store.sessionRegistry.forkPreviewTitle(sessionId) ??
        root.sessionCatalogStore.find(sessionId)?.title ??
        root.cakeChatCollectionStore.summaries.find((chat) => chat.sessionId === sessionId)
          ?.title ??
        "New chat"
      }
      renderTitle={(sessionId) => <ConversationBreadcrumb sessionId={sessionId} />}
      loadingLabel="Opening session"
      renderHeader={(session) =>
        session instanceof CakeChatSessionStore ? (
          <CakeChatPaneHeader session={session} />
        ) : (
          <ProjectPaneHeader session={session} browserMode={browserMode} />
        )
      }
      onInteract={(sessionId) =>
        root.appShellStore.recordConversationInteraction({
          kind: isCakeChatSessionId(sessionId) ? "cake-chat" : "project-session",
          sessionId,
        })
      }
    />
  );
});
