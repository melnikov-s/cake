import { toStoreEvent } from "../events/StoreEvent";
import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused artifact events to their projection and Store owners. */
export const observeArtifactEvents = (runtime: Runtime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.artifacts(),
    (event) => {
      try {
        if (event.type === "artifact-state-invalidated") {
          root.inlineWidgetStore.refreshArtifactState(event.lineageId);
          return;
        }
        if (event.type === "message-board-invalidated") {
          root.artifactLibraryStore.receiveBoardChange(event.lineageId);
          root.artifactPaneStore.receiveBoardChange(event.lineageId);
          return;
        }
        if (event.type === "renderer-events-ready") {
          root.inlineWidgetStore.refreshArtifactState();
          root.props.projection.artifacts.invalidate();
          // Reconcile content after stream subscription/reconnection, not only after opening.
          root.artifactLibraryStore.receiveBoardChange();
          root.artifactPaneStore.receiveBoardChange();
          return;
        }
        if (event.type === "artifact-updated" || event.type === "artifact-catalog-invalidated") {
          // Native artifact events are ordered invalidations. Every loaded session refetches its
          // effective projection because a family link may make a change visible there;
          // reconnect/remount starts with that same authoritative current query.
          root.props.projection.artifacts.invalidate();
          const lineageId =
            event.type === "artifact-updated" ? event.record.artifact.id : event.lineageId;
          root.artifactLibraryStore.receiveBoardChange(lineageId);
          root.artifactPaneStore.receiveBoardChange(lineageId);
          return;
        }
        const storeEvent = toStoreEvent(event);
        if (!storeEvent) return;
        root.extensionUiStore.receive(storeEvent);
      } catch (error) {
        root.projectWorkbenchStore.setError(error, `Artifact event: ${event.type}`);
      }
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Artifact event observation"),
    },
  );
