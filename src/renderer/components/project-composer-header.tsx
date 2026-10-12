import { observer, useStore } from "r-state-tree/react";
import { WorktreePill } from "@/components/worktree-pill";
import { SavedDraftRecovery } from "@/components/saved-draft-recovery";
import { ExtensionCompanionSlot } from "@/components/extension-companion-slot";
import { SessionPluginSlot } from "@/components/session-plugin-slot";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const ProjectComposerHeader = observer(function ProjectComposerHeader({
  session,
  recoverSavedDraft = false,
}: {
  session: ProjectSessionStore;
  recoverSavedDraft?: boolean;
}) {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const extensionUi = root.extensionUiStore;
  const sessionIsTemporary = store.sessionRegistry.pendingSessions.isTemporary(session.sessionId);
  const sessionIsDraft = store.sessionRegistry.pendingSessions.isDraft(session.sessionId);
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
        store.sessionRegistry.pendingSessions.savedRecord(session.sessionId)?.status ===
          "activating" && (
          <SavedDraftRecovery
            disabled={root.desktopConnection?.connected === false}
            recover={() =>
              void store.sessionRegistry.pendingSessions
                .recoverUncertain(session.sessionId)
                .catch((error: unknown) =>
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
        creation={store.sessionCreationStore.worktrees}
        actions={session.worktreeStore}
        record={root.sessionCatalogStore.managedWorktree(session.workspacePath)}
        sessionId={session.sessionId}
        projectPath={
          root.sessionCatalogStore.projectOfManagedWorktree(session.workspacePath) ??
          session.workspacePath
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
