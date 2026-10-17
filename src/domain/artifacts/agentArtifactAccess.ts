import { Effect, Schema } from "effect";
import {
  ArtifactStableRef,
  parseArtifactRef,
  artifactRevisionToRecord,
} from "../../contracts/artifacts/artifact-lineage";
import { ArtifactProjection } from "../../services/artifacts/ArtifactProjection";
import { ClientEvents } from "../../services/clients/ClientEvents";
import * as workflows from "./artifactWorkflows";

export const resolve = Effect.fn("AgentArtifacts.resolve")(function* (
  sessionId: string,
  reference: string,
) {
  const ref = yield* Schema.decodeUnknownEffect(ArtifactStableRef)(reference);
  const effective = yield* workflows.resolveEffectiveReference(sessionId, ref);
  const metadata = yield* (yield* ArtifactProjection).materialize({
    sessionId,
    revision: effective.revision,
    latestRevision: effective.latestRevision,
    linkMode: effective.link.selection.mode,
  });
  return { record: artifactRevisionToRecord(effective.revision), metadata };
});

export const link = Effect.fn("AgentArtifacts.link")(function* (
  sessionId: string,
  reference: string,
) {
  const ref = yield* Schema.decodeUnknownEffect(ArtifactStableRef)(reference);
  const parsed = parseArtifactRef(ref);
  yield* workflows.resolveReferenceMetadata(ref);
  yield* workflows.linkForSession(
    parsed.lineageId,
    sessionId,
    parsed.revision === undefined
      ? { mode: "follow-latest" }
      : { mode: "pinned", revision: parsed.revision },
  );
  (yield* ClientEvents).broadcast({
    type: "artifact-catalog-invalidated",
    lineageId: parsed.lineageId,
  });
  return (yield* resolve(sessionId, reference)).metadata;
});
