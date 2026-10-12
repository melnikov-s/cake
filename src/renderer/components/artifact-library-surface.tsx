import { observer, useStore } from "r-state-tree/react";
import { ArtifactSelectionSurface } from "@/components/artifact-selection-surface";
import { ArtifactLibrary } from "@/components/artifact-library";
import { RootStore } from "../stores/RootStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";

export const ArtifactLibrarySurface = observer(function ArtifactLibrarySurface() {
  const root = useStore(RootStore);
  const artifactLibrarySession = root.artifactLibraryStore.activeSessionId
    ? root.sessionRegistry.findSession(root.artifactLibraryStore.activeSessionId)
    : undefined;
  const artifactLibraryBehavior = artifactLibrarySession
    ? projectTranscriptBehaviorFor(root, artifactLibrarySession)
    : undefined;
  return (
    <ArtifactLibrary
      store={root.artifactLibraryStore}
      referencePreviews={root.artifactReferencePreviewStore}
      sessions={root.sessionCatalogStore}
      inlineWidgets={root.inlineWidgetStore}
      onOpenSourceLocation={artifactLibraryBehavior?.openSourceLocation}
      wrapArtifact={
        artifactLibrarySession && artifactLibraryBehavior?.showSelectionContextMenu
          ? (artifactId, children) => (
              <ArtifactSelectionSurface
                key={artifactId}
                session={artifactLibrarySession}
                artifactId={artifactId}
                showContextMenu={artifactLibraryBehavior.showSelectionContextMenu!}
                onReturnToChat={() => root.navigationStore.returnToWorkbench()}
              >
                {children}
              </ArtifactSelectionSurface>
            )
          : undefined
      }
    />
  );
});
