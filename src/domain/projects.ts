import { Effect, Stream } from "effect";
import type { ProjectCatalogUpdate } from "./catalog-data";
import { observeState } from "./application";

/** Observes main-owned Project registration facts as a current-first renderer projection. */
export const observeCatalog = Effect.fn("Projects.observeCatalog")(function* () {
  const changes = yield* observeState();
  let initialized = false;
  return changes.pipe(
    Stream.map((projection): ProjectCatalogUpdate => {
      const projects = projection.state.projects.map((project) => ({ ...project }));
      if (!initialized) {
        initialized = true;
        return { _tag: "Snapshot", revision: projection.revision, projects };
      }
      return {
        _tag: "Event",
        revision: projection.revision,
        event: { _tag: "Replaced", projects },
      };
    }),
  );
});
