import { Effect, Layer } from "effect";
import { ArtifactRuntime } from "../../../src/services/artifact-runtime/ArtifactRuntime";
import { ArtifactViews } from "../../../src/services/artifacts/ArtifactViews";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";

/** Unused artifact boundaries for tests whose subject is another application workflow. */
export const globalArtifactTestLayer = Layer.mergeAll(
  Layer.mock(ArtifactStorage, {
    catalog: () => Effect.succeed({ lineages: [], links: [] }),
    resolveLinks: () => Effect.succeed([]),
    read: () => Effect.succeed(undefined),
  }),
  Layer.mock(ArtifactRuntime, {
    status: (lineageId) =>
      Effect.succeed({ lineageId, revision: null, running: false, lastError: null }),
  }),
  Layer.mock(ArtifactViews, {
    report: () => Effect.void,
    read: () => Effect.succeed({ windows: [] }),
  }),
  Layer.mock(ClientEvents, { sendTo: () => false, broadcast: () => undefined }),
);
