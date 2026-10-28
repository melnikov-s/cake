import { observer, useStore } from "r-state-tree/react";
import { WorktreePill } from "@/components/worktree-pill";
import { SavedDraftRecovery } from "@/components/saved-draft-recovery";
import { ExtensionCompanionSlot } from "@/components/extension-companion-slot";
import { SessionPluginSlot } from "@/components/session-plugin-slot";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { ConversationActivity } from "./conversation-activity";

export const ProjectComposerHeader = observer(function ProjectComposerHeader({
  session,
  recoverSavedDraft = false,
}: {
  session: ProjectSessionStore;
  recoverSavedDraft?: boolean;
}) {
  const root = useStore(RootStore);
  const pendingSessions = root.sessionRegistry.pendingSessions;
  const extensionUi = root.extensionUiStore;
  const sessionIsTemporary = pendingSessions.isTemporary(session.sessionId);
  const sessionIsDraft = pendingSessions.isDraft(session.sessionId);
  const worktreeConfigurationMode = sessionIsDraft
    ? session.conversationSessionStore.composerStore.pendingSessionDraftStore.editing
      ? "edit-draft"
      : "activate-draft"
    : sessionIsTemporary
      ? "new-session"
      : undefined;
  return (
    <>
      <ExtensionCompanionSlot
        companions={session.model.extensionUi.companions}
        slot="composer.above"
        onAction={(companionId, action, value) =>
          extensionUi.dispatchCompanionAction(
            { sessionId: session.sessionId, workingDirectory: session.workspacePath },
            companionId,
            action,
            value,
          )
        }
      />
      <SessionPluginSlot
        sessionId={session.sessionId}
        slot="composer.above"
        plugins={root.sessionPluginStore}
        inlineWidgets={root.inlineWidgetStore}
        call={(pluginId, command, input) =>
          root.sessionPluginOperations.invoke(session.sessionId, pluginId, command, input)
        }
      />
      {recoverSavedDraft &&
        pendingSessions.savedRecord(session.sessionId)?.status === "activating" && (
          <SavedDraftRecovery
            disabled={root.desktopConnection?.connected === false}
            recover={() =>
              void pendingSessions.recoverUncertain(session.sessionId).catch((error: unknown) =>
                root.toastStore.show({
                  tone: "error",
                  title: "Could not recover saved Draft",
                  message: error instanceof Error ? error.message : String(error),
                }),
              )
            }
          />
        )}
      <WorktreePill
        header={
          <ConversationActivity
            placement="strip"
            sessionId={session.sessionId}
            subagents={session.subagentActivityStore}
            sideChat={session.conversationSessionStore.sideChatStore}
          />
        }
        creation={root.projectSessionCreationStore.worktrees}
        actions={session.worktreeStore}
        record={root.sessionCatalogStore.managedWorktree(session.workspacePath)}
        sessionId={session.sessionId}
        projectPath={root.sessionCatalogStore.projectPathFor(session.workspacePath)}
        landing={
          root.projectCatalogStore.find(
            root.sessionCatalogStore.projectPathFor(session.workspacePath),
          )?.settings.worktreeLanding
        }
        resolved={root.sessionCatalogStore.find(session.sessionId)?.resolved}
        isFamilyChild={
          root.sessionCatalogStore.find(session.sessionId)?.familyParentSessionId !== undefined &&
          root.sessionCatalogStore.find(session.sessionId)?.familyParentSessionId !==
            session.sessionId
        }
        configurationMode={worktreeConfigurationMode}
        onConfigured={() =>
          session.conversationSessionStore.composerStore.draftStore.requestFocus()
        }
      />
    </>
  );
});
