import { toStoreEvent } from "../events/StoreEvent";
import type { RootProjection } from "../models/RootProjection";
import { applyArtifactUpdate } from "../reducers/ArtifactReducer";
import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused artifact events to their projection and Store owners. */
export const observeArtifactEvents = (
  runtime: Runtime,
  projection: RootProjection,
  root: RootStore,
) =>
  runtime.observe(
    (client) => client.events.artifacts(),
    (event) => {
      try {
        if (event.type === "artifact-updated" || event.type === "artifact-catalog-invalidated") {
          const lineageId =
            event.type === "artifact-updated" ? event.record.artifact.id : event.lineageId;
          // Native artifact events are ordered invalidations. Every loaded panel refetches its
          // effective projection because a family link may make a change visible there;
          // reconnect/remount starts with that same authoritative current query.
          for (const sessionStore of root.sessionRegistry.sessions)
            sessionStore.sessionArtifactsStore.receive(lineageId);
          void root.artifactLibraryStore.load();
          if (event.type === "artifact-updated") {
            const session = projection.findProjectConversation(event.record.artifact.sessionId);
            if (session) applyArtifactUpdate(session, event.record);
          }
          return;
        }
        const storeEvent = toStoreEvent(event);
        if (!storeEvent) return;
        root.extensionUiStore.receive(storeEvent);
        if (storeEvent.type === "artifact-requested")
          root.sessionRegistry
            .findSession(storeEvent.record.artifact.sessionId)
            ?.receive(storeEvent);
      } catch (error) {
        root.projectWorkbenchStore.setError(error, `Artifact event: ${event.type}`);
      }
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Artifact event observation"),
    },
  );
