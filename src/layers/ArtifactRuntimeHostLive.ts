import { Effect, Layer } from "effect";
import { ArtifactRuntime } from "../services/artifact-runtime/ArtifactRuntime";
import { ArtifactRuntimeExecution } from "../services/artifact-runtime/ArtifactRuntimeExecution";
import { ArtifactRuntimeError } from "../contracts/artifacts/artifact-runtime";
import * as artifactCommands from "../domain/artifacts/artifactCommands";

/** Bind the canonical backend bridge after the session capability graph exists. */
export const ArtifactRuntimeHostLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof artifactCommands.invoke>>>();
    const runtime = yield* ArtifactRuntime;
    yield* runtime.setHost({
      invokeCommand: ({ lineageId, command, input, callingSessionId, windowConnectionId }) =>
        artifactCommands
          .invoke(command, input, {
            artifactId: lineageId,
            ...(callingSessionId === undefined ? null : { callingSessionId }),
            ...(windowConnectionId === undefined ? null : { windowConnectionId }),
          })
          .pipe(
            Effect.provide(context),
            Effect.provideService(ArtifactRuntimeExecution, lineageId),
            Effect.mapError(
              (cause) => new ArtifactRuntimeError({ operation: command, message: cause.message }),
            ),
          ),
    });
  }),
);
