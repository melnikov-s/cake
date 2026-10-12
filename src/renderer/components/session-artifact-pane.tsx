import { type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { ArtifactSelectionSurface } from "@/components/artifact-selection-surface";
import { ArtifactPaneLayout } from "@/components/artifact-pane-layout";
import { RootStore } from "../stores/RootStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";

export const SessionArtifactPane = observer(function SessionArtifactPane({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const root = useStore(RootStore);
  const projectSession = root.sessionRegistry.findSession(sessionId);
  const behavior = projectSession ? projectTranscriptBehaviorFor(root, projectSession) : undefined;
  return (
    <ArtifactPaneLayout
      store={root.artifactPaneStore}
      sessionId={sessionId}
      referencePreviews={root.artifactReferencePreviewStore}
      sessions={root.sessionCatalogStore}
      inlineWidgets={root.inlineWidgetStore}
      onOpenSourceLocation={behavior?.openSourceLocation}
      wrapArtifact={
        projectSession && behavior?.showSelectionContextMenu
          ? (artifactId, content) => (
              <ArtifactSelectionSurface
                key={artifactId}
                session={projectSession}
                artifactId={artifactId}
                showContextMenu={behavior.showSelectionContextMenu!}
                onReturnToChat={() => {
                  root.artifactPaneStore.close();
                  root.navigationStore.returnToWorkbench();
                }}
              >
                {content}
              </ArtifactSelectionSurface>
            )
          : undefined
      }
    >
      {children}
    </ArtifactPaneLayout>
  );
});
