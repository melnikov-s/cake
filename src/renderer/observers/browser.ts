import { effect } from "r-state-tree";
import type { Runtime } from "../runtime";
import type { BrowserShellStore } from "../stores/BrowserShellStore";
import type { RootProjection } from "../models/RootProjection";
import {
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
} from "../reducers/CatalogReducer";
import { applyConversationUpdate } from "../reducers/ConversationReducer";
import { toStoreEvent } from "../events/StoreEvent";

/** Tab-owned observation demand. Reuses the same validated streams and transactional reducers.
 * Reconnection restarts observations with snapshots, never commands or transcript replay.
 */
export function observeBrowser(
  runtime: Runtime,
  projection: RootProjection,
  root: BrowserShellStore,
) {
  const options = { reportFailure: (error: unknown) => root.reportError(error) };
  const stops = [
    runtime.observe(
      (client) => client.projects.observeCatalog(),
      (update) => applyProjectCatalogUpdate(projection.projects, update),
      options,
    ),
    runtime.observe(
      (client) => client.events.artifacts(),
      (event) => {
        const value = toStoreEvent(event);
        if (!value) return;
        if (value.type === "ui-requested") root.extensionUi.receive(value);
        if (value.type === "artifact-requested") {
          const session = root.sessions.find(
            (entry) => entry.id === value.record.artifact.sessionId,
          );
          session?.interaction.receive(value);
        }
      },
      options,
    ),
    runtime.observe(
      (client) => client.events.application(),
      (event) => {
        if (event.type === "draw-control-requested") {
          void root.client.drawControl
            .respond({
              sessionId: event.sessionId,
              drawRequestId: event.drawRequestId,
              response: {
                ok: false,
                code: "CAPABILITY_UNAVAILABLE",
                message: "Draw editing is unavailable in basic browser chat.",
              },
            })
            .catch((error: unknown) => root.reportError(error));
          return;
        }
        const value = toStoreEvent(event);
        if (!value) return;
        if (value.type === "project-session-control-requested") {
          void root.client.projectSessions
            .respondControl(value.sessionId, value.controlRequestId, {
              ok: false,
              error: "This presentation operation is unavailable in basic browser chat.",
            })
            .catch((error: unknown) => root.reportError(error));
        } else root.extensionUi.receive(value);
      },
      options,
    ),
  ];
  const catalogs = new Map<string, () => void>();
  const conversations = new Map<string, () => void>();
  const stopDemand = effect(() => {
    for (const project of projection.projects.projects) {
      if (catalogs.has(project.path)) continue;
      const query = { projectPath: project.path, resolved: false };
      catalogs.set(
        project.path,
        runtime.observe(
          (client) => client.projectSessions.observeCatalog(query),
          (update) => {
            applySessionCatalogGroupUpdate(projection.sessionCatalog, query, update);
            if (update._tag === "Snapshot") root.navigation.synchronizedProjects.add(project.path);
          },
          options,
        ),
      );
    }
    for (const [path, stop] of catalogs)
      if (!projection.projects.find(path)) {
        stop();
        catalogs.delete(path);
      }
    for (const session of root.sessions) {
      const ready = session.created && session.opened;
      if (ready && !conversations.has(session.id)) {
        conversations.set(
          session.id,
          runtime.observe(
            (client) =>
              client.conversations.observe({
                _tag: "ProjectSession",
                sessionId: session.id,
                workingDirectory: session.workingDirectory,
              }),
            (update) => {
              applyConversationUpdate(session.model, update);
              if (update._tag === "Snapshot") session.receivedSnapshot();
            },
            options,
          ),
        );
      } else if (!ready) {
        conversations.get(session.id)?.();
        conversations.delete(session.id);
      }
    }
  });
  return () => {
    stopDemand();
    for (const stop of [...stops, ...catalogs.values(), ...conversations.values()]) stop();
  };
}
