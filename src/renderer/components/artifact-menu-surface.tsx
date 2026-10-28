import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { ArtifactHost } from "./artifact-host";
import { ArtifactSelectionSurface } from "./artifact-selection-surface";
import { FullscreenSurface } from "./fullscreen-surface";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";

/** Menu selections use the same live artifact host and fullscreen conversation as inline artifacts. */
export const ArtifactMenuSurface = observer(function ArtifactMenuSurface() {
  const root = useStore(RootStore);
  const store = root.artifactMenuStore;
  if (!store.visible) return null;
  const detail = store.detailStore;
  const lineage = detail.selectedLineage;
  const record = detail.selectedRevision
    ? lineage?.revision(detail.selectedRevision)?.record
    : undefined;
  const close = () => store.close();
  if (!record)
    return (
      <FullscreenSurface eyebrow="Artifact" title={lineage?.title ?? "Artifact"} onClose={close}>
        {detail.error ? (
          <Callout variant="error">{detail.error}</Callout>
        ) : (
          <LoadingState label="Loading artifact" />
        )}
      </FullscreenSurface>
    );

  const sessionId = store.sessionId ?? record.artifact.sessionId;
  const project = root.sessionRegistry.findSession(sessionId);
  const behavior = project ? projectTranscriptBehaviorFor(root, project) : undefined;
  return (
    <ArtifactHost
      key={record.artifact.id}
      record={record}
      presentation="fullscreen"
      onClose={close}
      stateSessionId={sessionId}
      inlineWidgets={root.inlineWidgetStore}
      messageBoard={detail.messageBoardStore}
      onOpenSourceLocation={behavior?.openSourceLocation}
      wrapContent={
        project && behavior?.showSelectionContextMenu
          ? (content) => (
              <ArtifactSelectionSurface
                className="h-full min-h-0"
                session={project}
                artifactId={record.artifact.id}
                showContextMenu={behavior.showSelectionContextMenu!}
                onReturnToChat={close}
              >
                {content}
              </ArtifactSelectionSurface>
            )
          : undefined
      }
    />
  );
});
