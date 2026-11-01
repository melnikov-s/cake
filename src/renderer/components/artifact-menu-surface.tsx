import { useLayoutEffect, useRef } from "react";
import type { ArtifactMenuStore } from "../stores/ArtifactMenuStore";
import { SidePanel } from "./ui/side-panel";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { ArtifactHost } from "./artifact-host";
import { ArtifactSelectionSurface } from "./artifact-selection-surface";
import { FullscreenSurface } from "./fullscreen-surface";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";

/** A single selection, without library navigation or listings. */
export const ArtifactMenuSurface = observer(function ArtifactMenuSurface({
  paneStore,
}: {
  paneStore?: ArtifactMenuStore;
}) {
  const root = useStore(RootStore);
  const store = paneStore ?? root.artifactMenuStore;
  const shown = store.visible && (paneStore ? store.pane?.target?.artifact === store : !store.pane);
  const surfaceId = useRef(crypto.randomUUID()).current;
  const presentation = root.artifactPresentationStore;
  const detail = store.detailStore;
  const lineage = detail.selectedLineage;
  const record = detail.selectedRevision
    ? lineage?.revision(detail.selectedRevision)?.record
    : undefined;
  const close = () => store.close();
  useLayoutEffect(() => {
    if (!shown || !paneStore || !record || !store.sessionId) return;
    presentation.show(surfaceId, {
      sessionId: store.sessionId,
      artifactId: record.artifact.id,
      revision: record.artifact.revision,
    });
    return () => presentation.close(surfaceId);
  }, [shown, paneStore, presentation, surfaceId, store.sessionId, record]);
  if (!shown) return null;
  if (!record && paneStore)
    return (
      <SidePanel title={lineage?.title ?? "Artifact"} onClose={close}>
        {detail.error ? (
          <Callout variant="error">{detail.error}</Callout>
        ) : (
          <LoadingState label="Loading artifact" />
        )}
      </SidePanel>
    );
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
      presentation={paneStore ? "side-panel" : "fullscreen"}
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
