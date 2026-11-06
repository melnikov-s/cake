import { Context, Effect, Layer } from "effect";
import type {
  ArtifactViewing,
  ArtifactViewingReport,
} from "../../contracts/artifacts/artifact-viewing";
import { ClientConnections } from "../clients/ClientConnections";

/** Disposable window projections. Artifact identities and execution live elsewhere. */
export class ArtifactViews extends Context.Service<
  ArtifactViews,
  {
    readonly report: (connectionId: number, report: ArtifactViewingReport) => Effect.Effect<void>;
    readonly read: (callingWindow?: number) => Effect.Effect<ArtifactViewing>;
  }
>()("cake/services/artifacts/ArtifactViews") {}

export const ArtifactViewsLive = Layer.effect(
  ArtifactViews,
  Effect.gen(function* () {
    const connections = yield* ClientConnections;
    const views = new Map<number, ArtifactViewingReport>();
    yield* Effect.addFinalizer(() => Effect.sync(() => views.clear()));
    return ArtifactViews.of({
      report: Effect.fn("ArtifactViews.report")((connectionId, report) =>
        Effect.sync(() => {
          if (connections.kind(connectionId) === undefined) return;
          views.set(connectionId, report);
        }),
      ),
      read: Effect.fn("ArtifactViews.read")((callingWindow) =>
        Effect.sync(() => {
          for (const connectionId of views.keys())
            if (connections.kind(connectionId) === undefined) views.delete(connectionId);
          return {
            windows: [...views]
              .sort(([left], [right]) => left - right)
              .map(([connectionId, report]) => ({ connectionId, ...report })),
            ...(callingWindow === undefined ? null : { callingWindow }),
          };
        }),
      ),
    });
  }),
);
