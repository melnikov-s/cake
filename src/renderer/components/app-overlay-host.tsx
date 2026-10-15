import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { useAppFullscreenResponse } from "../hooks/use-app-fullscreen-response";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { AgentAvailabilityNotice } from "./agent-availability-notice";
import { AppNotifications } from "./app-notifications";
import { ExtensionRequestDialog } from "./extension-request-dialog";
import { FullscreenMessage } from "./fullscreen-message";
import { MessageReferencePreview } from "./message-reference-preview";
import { AttachmentReferencePreview } from "./attachment-reference-preview";
import { QuakeTerminal } from "./quake-terminal";
import { SessionContinuationDialog } from "./session-continuation-dialog";
import { TreeNavigationDialog } from "./tree-navigation-dialog";
import { UiHintMode } from "./ui/ui-hint-mode";
import { WorkspaceTrustDialog } from "./workspace-trust-dialog";

export const AppOverlayHost = observer(function AppOverlayHost({
  workspaceMode,
  fullscreen,
}: {
  workspaceMode: boolean;
  fullscreen: ReturnType<typeof useAppFullscreenResponse>;
}) {
  const root = useStore(RootStore);
  const workbench = root.projectWorkbenchStore;
  const terminal = root.terminalStore;
  const session = workbench.activeSession;
  const { currentChatSession, fullscreenPart, closeResponse } = fullscreen;
  const floatingTerminal = !terminal.docked ? (
    <QuakeTerminal store={terminal} retirement={root.workingDirectoryRetirementStore} />
  ) : undefined;

  // Workspace modes intentionally retain their existing smaller overlay set.
  if (workspaceMode)
    return (
      <>
        {floatingTerminal}
        <MessageReferencePreview store={root.navigationStore.messageReferencePreview} />
        <AttachmentReferencePreview store={root.navigationStore.attachmentReferencePreview} />
        <SessionContinuationDialog store={workbench.sessionContinuationStore} />
        <TreeNavigationDialog store={workbench.commandPaneStore} />
        <UiHintMode store={root.uiHintModeStore} />
      </>
    );

  return (
    <>
      <MessageReferencePreview store={root.navigationStore.messageReferencePreview} />
      <AttachmentReferencePreview store={root.navigationStore.attachmentReferencePreview} />
      <WorkspaceTrustDialog />
      <SessionContinuationDialog store={workbench.sessionContinuationStore} />
      <TreeNavigationDialog store={workbench.commandPaneStore} />
      <ExtensionRequestDialog />
      <AppNotifications />
      {floatingTerminal}
      {fullscreenPart?.kind === "text" && fullscreenPart.role === "assistant" && (
        <FullscreenMessage
          eyebrow="Full response"
          title="Cake"
          text={fullscreenPart.text}
          markdown
          streaming={fullscreenPart.status === "streaming"}
          partId={fullscreenPart.id}
          highlightAnchors={currentChatSession?.conversationSessionStore.chatStore.annotations.filter(
            (annotation) => annotation.messageId === fullscreenPart.id,
          )}
          onOpenSourceLocation={
            root.appShellStore.surface === "workbench" && session
              ? projectTranscriptBehaviorFor(root, session).openSourceLocation
              : undefined
          }
          onClose={closeResponse}
        />
      )}
      <UiHintMode store={root.uiHintModeStore} />
      <AgentAvailabilityNotice />
    </>
  );
});
