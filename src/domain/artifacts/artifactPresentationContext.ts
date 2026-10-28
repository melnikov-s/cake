import { Effect, Option, Schema } from "effect";
import {
  SessionChatError,
  type SessionChatPromptInput,
} from "../../contracts/conversations/conversation-data";
import { addArtifactPresentationReminder } from "../../contracts/artifacts/artifact-presentation-context";
import { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import * as artifactWorkflows from "./artifactWorkflows";

/** Validate the owning conversation and use normal linked-artifact access, never grant by ID. */
export const prepareInput = Effect.fn("ArtifactPresentationContext.prepareInput")(function* (
  input: SessionChatPromptInput,
  text: string,
) {
  if (input.crossSession || input.artifactPresentation === undefined || /^[!/]/.test(input.text))
    return text;
  const view = input.artifactPresentation;
  if (view === null) return addArtifactPresentationReminder(text, null);
  if (view.sessionId !== input.sessionId)
    return yield* new SessionChatError({
      operation: "artifactPresentation",
      message: "Artifact presentation belongs to another conversation",
    });
  const storage = yield* Effect.serviceOption(ArtifactStorage);
  if (Option.isNone(storage))
    return yield* new SessionChatError({
      operation: "artifactPresentation",
      message: "Artifact access is unavailable",
    });
  const exactRef = yield* Schema.decodeUnknownEffect(ArtifactStableRef)(
    `cake://artifact/${view.artifactId}@r${view.revision}`,
  );
  const { revision } = yield* artifactWorkflows
    .resolveEffectiveReference(input.sessionId, exactRef)
    .pipe(Effect.provideService(ArtifactStorage, storage.value));
  const artifact = revision.snapshot;
  return addArtifactPresentationReminder(text, {
    mode: "presentation",
    sessionId: input.sessionId,
    artifactId: artifact.id,
    revision: artifact.revision,
    title: artifact.title ?? null,
    type: artifact.kind,
    exactRef,
  });
});
