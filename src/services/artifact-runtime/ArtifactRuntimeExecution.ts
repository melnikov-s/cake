import { Context, Effect } from "effect";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { ArtifactRuntimeError } from "../../contracts/artifacts/artifact-runtime";

/** Synchronous bridge execution origin, not a caller session or an authority grant. */
export const ArtifactRuntimeExecution = Context.Reference<ArtifactLineageId | undefined>(
  "cake/services/artifact-runtime/ArtifactRuntimeExecution",
  { defaultValue: () => undefined },
);

/** A worker cannot await an operation waiting for the permit held by that worker. */
export const rejectArtifactRuntimeReentry = Effect.fn("ArtifactRuntime.rejectReentry")(function* (
  lineageId: ArtifactLineageId,
  operation: string,
) {
  if ((yield* ArtifactRuntimeExecution) === lineageId)
    return yield* new ArtifactRuntimeError({
      operation,
      message:
        "An artifact handler cannot synchronously execute or control its own runtime through Cake. Return from the handler first; external callers and other artifacts remain supported.",
    });
});
