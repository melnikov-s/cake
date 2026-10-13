import { Effect } from "effect";
import {
  ArtifactStateConflict,
  ArtifactStateError,
  editArtifactState,
  type ArtifactStateReplacement,
  type ArtifactStateUpdate,
} from "../../contracts/artifacts/artifact-state";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { resolveEffectiveReference } from "./artifactWorkflows";

const requireWidget = Effect.fn("ArtifactState.requireWidget")(function* (
  sessionId: string,
  lineageId: ArtifactLineageId,
) {
  const effective = yield* resolveEffectiveReference(sessionId, `cake://artifact/${lineageId}`);
  if (effective.revision.snapshot.kind !== "widget")
    return yield* new ArtifactStateError({
      message: "Only linked widget artifacts own mutable state",
    });
});
export const read = Effect.fn("ArtifactState.read")(function* (input: {
  sessionId: string;
  lineageId: ArtifactLineageId;
}) {
  yield* requireWidget(input.sessionId, input.lineageId);
  return yield* (yield* ArtifactStorage).readState(input.lineageId);
});
export const replace = Effect.fn("ArtifactState.replace")(function* (
  input: ArtifactStateReplacement & { sessionId: string },
) {
  yield* requireWidget(input.sessionId, input.lineageId);
  const state = yield* (yield* ArtifactStorage).replaceState(input);
  (yield* ClientEvents).broadcast({
    type: "artifact-state-invalidated",
    lineageId: input.lineageId,
  });
  return state;
});
export const update = Effect.fn("ArtifactState.update")(function* (
  input: ArtifactStateUpdate & { sessionId: string },
) {
  const current = yield* read(input);
  if (current.version !== input.expectedVersion)
    return yield* new ArtifactStateConflict({
      lineageId: input.lineageId,
      expectedVersion: input.expectedVersion,
      actualVersion: current.version,
    });
  const value = yield* Effect.try({
    try: () => editArtifactState(current.value, input.edits),
    catch: (cause) =>
      new ArtifactStateError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
  return yield* replace({ ...input, value });
});
