import { observer, StoreProvider, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { BlockingInterviews } from "./blocking-interviews";
import { ProjectComposerAccessory } from "./project-composer-accessory";
import { ProjectComposerHeader } from "./project-composer-header";
import { ProjectWorkspaceControls } from "./project-workspace-controls";
import { WorkspaceFrame } from "./workspace-frame";

export const ProjectWorkspaceSurface = observer(function ProjectWorkspaceSurface({
  session,
  mode,
  browserMode,
}: {
  session: ProjectSessionStore;
  mode: Exclude<ProjectSessionStore["presentationMode"], "normal">;
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  return (
    <StoreProvider key={session.sessionId} store={session}>
      <WorkspaceFrame
        session={session}
        mode={mode}
        headerActions={
          <ProjectWorkspaceControls session={session} mode={mode} browserMode={browserMode} />
        }
        projectComposerHeader={<ProjectComposerHeader session={session} recoverSavedDraft />}
        projectComposerContent={
          <BlockingInterviews
            interviews={session.conversationSessionStore.interviewStore.interviews}
            parts={session.canonicalParts}
            inlineWidgets={root.inlineWidgetStore}
          />
        }
        projectComposerLeadingAccessory={
          root.settingsStore.appearance.sessionAvatarsEnabled
            ? { visible: true, content: <ProjectComposerAccessory session={session} /> }
            : undefined
        }
        sessionTitle={root.projectWorkbenchStore.sessionTitle}
        transcriptBehavior={projectTranscriptBehaviorFor(root, session)}
      />
    </StoreProvider>
  );
});
