import { Context, Effect, Layer, Stream } from "effect";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { ApplicationState } from "../storage/ApplicationState";
import { ArtifactStorage } from "../storage/ArtifactStorage";

/**
 * The single permission for widget backend work: schedules, runtime workers and their Cake calls.
 * Only an attached instance runs, and only at the revision its attachments render (the instance's
 * current revision). Unattached instances and every other revision never run.
 */
export class WidgetRunGate extends Context.Service<
  WidgetRunGate,
  {
    /** The one revision allowed to run, or undefined when the instance is not attached. */
    readonly attachedRevision: (lineageId: ArtifactLineageId) => Effect.Effect<number | undefined>;
    /** Signals each attachment change so running work can be re-checked immediately. */
    readonly changes: () => Stream.Stream<void>;
  }
>()("cake/services/artifact-runtime/WidgetRunGate") {
  static readonly layer = Layer.effect(
    WidgetRunGate,
    Effect.gen(function* () {
      const application = yield* ApplicationState;
      const storage = yield* ArtifactStorage;
      return WidgetRunGate.of({
        attachedRevision: Effect.fn("WidgetRunGate.attachedRevision")(function* (lineageId) {
          if (
            !application
              .snapshot()
              .widgetAttachments.some((attachment) => attachment.lineageId === lineageId)
          )
            return undefined;
          const current = yield* storage.read(lineageId).pipe(
            // An unreadable instance is not runnable; never fail open.
            Effect.catch((error) =>
              Effect.logWarning("Widget run gate could not read artifact", error).pipe(
                Effect.as(undefined),
              ),
            ),
          );
          return current?.snapshot.kind === "widget" ? current.metadata.revision : undefined;
        }),
        // Unrelated application transactions keep the same attachment array.
        changes: () =>
          application.changes().pipe(
            Stream.map((projection) => projection.state.widgetAttachments),
            Stream.changesWith((left, right) => left === right),
            Stream.as(undefined),
          ),
      });
    }),
  );
}
