import { Effect } from "effect";
import {
  ArtifactStateError,
  ArtifactStateConflict,
  editArtifactState,
  type ArtifactStateReplacement,
  type ArtifactStateUpdate,
} from "../../contracts/artifacts/artifact-state";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { ClientEvents } from "../../services/clients/ClientEvents";

interface AttachmentScope {
  readonly attachmentId: string;
  readonly lineageId: ArtifactLineageId;
}

/** Explicit view scope, never a change to generic artifact/link access or global retention. */
const requireAttachment = Effect.fn("WidgetState.requireAttachment")(function* (
  input: AttachmentScope,
) {
  const attachment = (yield* ApplicationState)
    .snapshot()
    .widgetAttachments.find(
      (entry) => entry.id === input.attachmentId && entry.lineageId === input.lineageId,
    );
  if (!attachment)
    return yield* new ArtifactStateError({
      message: "This widget attachment is no longer available",
    });
  const widget = yield* (yield* ArtifactStorage).read(input.lineageId);
  if (widget?.snapshot.kind !== "widget")
    return yield* new ArtifactStateError({ message: "Only widget instances own saved state" });
});

export const read = Effect.fn("WidgetState.read")(function* (input: AttachmentScope) {
  yield* requireAttachment(input);
  return yield* (yield* ArtifactStorage).readState(input.lineageId);
});

export const replace = Effect.fn("WidgetState.replace")(function* (
  input: ArtifactStateReplacement & AttachmentScope,
) {
  yield* requireAttachment(input);
  const state = yield* (yield* ArtifactStorage).replaceState(input);
  (yield* ClientEvents).broadcast({
    type: "artifact-state-invalidated",
    lineageId: input.lineageId,
  });
  return state;
});

export const update = Effect.fn("WidgetState.update")(function* (
  input: ArtifactStateUpdate & AttachmentScope,
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
