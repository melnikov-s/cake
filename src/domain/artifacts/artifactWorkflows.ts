import { DateTime, Effect, Schema } from "effect";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import { ArtifactStorage, ArtifactStorageError } from "../../services/storage/ArtifactStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  type ArtifactCatalog,
  type ArtifactLineage,
  type ArtifactLineageId,
  type ArtifactLink,
  type ArtifactLinkTarget,
  type ArtifactRevision,
  type ArtifactRevisionMetadata,
  type ArtifactRevisionNumber,
  type ArtifactStableRef,
  parseArtifactRef,
} from "./artifact-lineage";

export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()("ArtifactNotFound", {
  lineageId: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
}) {}

class ArtifactNotLinked extends Schema.TaggedError<ArtifactNotLinked>()("ArtifactNotLinked", {
  sessionId: Schema.String,
  lineageId: Schema.String,
}) {}

export interface CreateArtifactInput {
  readonly sessionId: string;
  readonly lineageId: ArtifactLineageId;
  readonly snapshot: CakeArtifactV1;
  readonly workingDirectory: string;
}

export interface PublishArtifactInput extends CreateArtifactInput {
  readonly expectedLatestRevision: number;
  readonly restoredFromRevision?: ArtifactRevisionNumber;
}

export interface EffectiveArtifact {
  readonly revision: ArtifactRevision;
  readonly link: ArtifactLink;
}

interface ArtifactReferenceMetadata {
  readonly lineage: ArtifactLineage;
  readonly revision: ArtifactRevisionMetadata;
  readonly links: ReadonlyArray<ArtifactLink>;
}

const sameTarget = (left: ArtifactLinkTarget, right: ArtifactLinkTarget) =>
  left.type === right.type &&
  (left.type === "session"
    ? right.type === "session" && left.sessionId === right.sessionId
    : right.type === "family" && left.familyId === right.familyId);

const familyTargetForSession = Effect.fn("Artifacts.familyTargetForSession")(function* (
  sessionId: string,
) {
  const family = yield* (yield* SessionFamilyStorage).familyForMember(sessionId);
  return family === undefined
    ? undefined
    : ({ type: "family", familyId: family.familyId } satisfies ArtifactLinkTarget);
});

const effectiveLinks = Effect.fn("Artifacts.effectiveLinks")(function* (sessionId: string) {
  // Membership lookup deliberately happens before catalog access. Failure must not
  // degrade a family member to standalone visibility.
  const familyTarget = yield* familyTargetForSession(sessionId);
  const catalog = yield* (yield* ArtifactStorage).catalog();
  const directTarget = { type: "session", sessionId } satisfies ArtifactLinkTarget;
  const selected = new Map<string, ArtifactLink>();
  if (familyTarget)
    for (const link of catalog.links)
      if (sameTarget(link.target, familyTarget)) selected.set(link.lineageId, link);
  // A direct link is the more specific projection when both scopes link one lineage.
  for (const link of catalog.links)
    if (sameTarget(link.target, directTarget)) selected.set(link.lineageId, link);
  return { catalog, links: [...selected.values()] };
});

const requireLineage = (
  catalog: ArtifactCatalog,
  lineageId: ArtifactLineageId,
): Effect.Effect<ArtifactLineage, ArtifactNotFound> => {
  const lineage = catalog.lineages.find((candidate) => candidate.id === lineageId);
  return lineage ? Effect.succeed(lineage) : Effect.fail(new ArtifactNotFound({ lineageId }));
};

export const create = Effect.fn("Artifacts.create")(function* (input: CreateArtifactInput) {
  if (
    input.snapshot.id !== input.lineageId ||
    input.snapshot.sessionId !== input.sessionId ||
    input.snapshot.revision !== 1
  )
    return yield* new ArtifactStorageError({
      operation: "create",
      message: "Artifact snapshot must identify the creating session, lineage, and revision one",
    });

  const families = yield* SessionFamilyStorage;
  return yield* families.withMemberLock(
    input.sessionId,
    Effect.gen(function* () {
      const familyTarget = yield* familyTargetForSession(input.sessionId);
      const storage = yield* ArtifactStorage;
      const revision = yield* storage.publish({
        lineageId: input.lineageId,
        expectedLatestRevision: 0,
        snapshot: input.snapshot,
        workingDirectory: input.workingDirectory,
      });
      yield* storage.putLink({
        lineageId: input.lineageId,
        target: familyTarget ?? { type: "session", sessionId: input.sessionId },
        selection: { mode: "follow-latest" },
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      return revision;
    }),
  );
});

export const listEffectiveSessionArtifacts = Effect.fn("Artifacts.listEffectiveSessionArtifacts")(
  function* (sessionId: string) {
    const storage = yield* ArtifactStorage;
    const { links } = yield* effectiveLinks(sessionId);
    return yield* Effect.forEach(
      links,
      Effect.fn("Artifacts.resolveEffectiveLink")(function* (link): Effect.fn.Return<
        EffectiveArtifact,
        ArtifactStorageError | ArtifactNotFound
      > {
        const revision = yield* storage.read(
          link.lineageId,
          link.selection.mode === "pinned" ? link.selection.revision : undefined,
        );
        if (!revision)
          return yield* new ArtifactNotFound({
            lineageId: link.lineageId,
            ...(link.selection.mode === "pinned" ? { revision: link.selection.revision } : null),
          });
        return { revision, link };
      }),
    );
  },
);

const requireEffectiveLink = Effect.fn("Artifacts.requireEffectiveLink")(function* (
  sessionId: string,
  lineageId: ArtifactLineageId,
) {
  const { links } = yield* effectiveLinks(sessionId);
  const link = links.find((candidate) => candidate.lineageId === lineageId);
  if (!link) return yield* new ArtifactNotLinked({ sessionId, lineageId });
  return link;
});

export const publish = Effect.fn("Artifacts.publish")(function* (input: PublishArtifactInput) {
  yield* requireEffectiveLink(input.sessionId, input.lineageId);
  if (
    input.snapshot.id !== input.lineageId ||
    input.snapshot.sessionId !== input.sessionId ||
    input.snapshot.revision !== input.expectedLatestRevision + 1
  )
    return yield* new ArtifactStorageError({
      operation: "publish",
      message: "Artifact snapshot must identify the publishing session, lineage, and next revision",
    });
  return yield* (yield* ArtifactStorage).publish({
    lineageId: input.lineageId,
    expectedLatestRevision: input.expectedLatestRevision,
    snapshot: input.snapshot,
    workingDirectory: input.workingDirectory,
    ...(input.restoredFromRevision === undefined
      ? null
      : { restoredFromRevision: input.restoredFromRevision }),
  });
});

export const restore = Effect.fn("Artifacts.restore")(function* (input: {
  readonly sessionId: string;
  readonly lineageId: ArtifactLineageId;
  readonly sourceRevision: ArtifactRevisionNumber;
  readonly expectedLatestRevision: number;
  readonly workingDirectory: string;
}) {
  yield* requireEffectiveLink(input.sessionId, input.lineageId);
  const storage = yield* ArtifactStorage;
  const source = yield* storage.read(input.lineageId, input.sourceRevision);
  if (!source)
    return yield* new ArtifactNotFound({
      lineageId: input.lineageId,
      revision: input.sourceRevision,
    });
  const nextRevision = input.expectedLatestRevision + 1;
  return yield* storage.publish({
    lineageId: input.lineageId,
    expectedLatestRevision: input.expectedLatestRevision,
    snapshot: {
      ...source.snapshot,
      sessionId: input.sessionId,
      revision: nextRevision,
    },
    workingDirectory: input.workingDirectory,
    restoredFromRevision: input.sourceRevision,
  });
});

export const readExactRevision = Effect.fn("Artifacts.readExactRevision")(function* (
  lineageId: ArtifactLineageId,
  revision: ArtifactRevisionNumber,
) {
  const value = yield* (yield* ArtifactStorage).read(lineageId, revision);
  if (!value) return yield* new ArtifactNotFound({ lineageId, revision });
  return value;
});

export const history = Effect.fn("Artifacts.history")(function* (lineageId: ArtifactLineageId) {
  const storage = yield* ArtifactStorage;
  const catalog = yield* storage.catalog();
  yield* requireLineage(catalog, lineageId);
  return yield* storage.listRevisions(lineageId);
});

const putLink = Effect.fn("Artifacts.putLink")(function* (
  lineageId: ArtifactLineageId,
  target: ArtifactLinkTarget,
  selection: ArtifactLink["selection"],
) {
  yield* (yield* ArtifactStorage).putLink({
    lineageId,
    target,
    selection,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
});

export const linkSession = Effect.fn("Artifacts.linkSession")(
  (
    lineageId: ArtifactLineageId,
    sessionId: string,
    selection: ArtifactLink["selection"] = { mode: "follow-latest" },
  ) => putLink(lineageId, { type: "session", sessionId }, selection),
);

export const linkFamily = Effect.fn("Artifacts.linkFamily")(
  (
    lineageId: ArtifactLineageId,
    familyId: string,
    selection: ArtifactLink["selection"] = { mode: "follow-latest" },
  ) => putLink(lineageId, { type: "family", familyId }, selection),
);

export const unlinkSession = Effect.fn("Artifacts.unlinkSession")(function* (
  lineageId: ArtifactLineageId,
  sessionId: string,
) {
  yield* (yield* ArtifactStorage).removeLink({ type: "session", sessionId }, lineageId);
});

export const unlinkFamily = Effect.fn("Artifacts.unlinkFamily")(function* (
  lineageId: ArtifactLineageId,
  familyId: string,
) {
  yield* (yield* ArtifactStorage).removeLink({ type: "family", familyId }, lineageId);
});

export const setSelection = Effect.fn("Artifacts.setSelection")(function* (
  lineageId: ArtifactLineageId,
  target: ArtifactLinkTarget,
  selection: ArtifactLink["selection"],
) {
  const storage = yield* ArtifactStorage;
  const catalog = yield* storage.catalog();
  const existing = catalog.links.find(
    (link) => link.lineageId === lineageId && sameTarget(link.target, target),
  );
  if (!existing) return yield* new ArtifactNotFound({ lineageId });
  yield* storage.putLink({ ...existing, selection });
});

export const listGlobalLineages = Effect.fn("Artifacts.listGlobalLineages")(function* () {
  return (yield* (yield* ArtifactStorage).catalog()).lineages;
});

export const listLineageLinks = Effect.fn("Artifacts.listLineageLinks")(function* (
  lineageId: ArtifactLineageId,
) {
  const catalog = yield* (yield* ArtifactStorage).catalog();
  yield* requireLineage(catalog, lineageId);
  return catalog.links.filter((link) => link.lineageId === lineageId);
});

export const resolveReferenceMetadata = Effect.fn("Artifacts.resolveReferenceMetadata")(function* (
  reference: ArtifactStableRef,
) {
  const parsed = parseArtifactRef(reference);
  const catalog = yield* (yield* ArtifactStorage).catalog();
  const lineage = yield* requireLineage(catalog, parsed.lineageId);
  const revisionNumber = parsed.revision ?? lineage.latestRevision;
  const revision = lineage.revisions.find((item) => item.revision === revisionNumber);
  if (!revision)
    return yield* new ArtifactNotFound({
      lineageId: parsed.lineageId,
      revision: revisionNumber,
    });
  return {
    lineage,
    revision,
    links: catalog.links.filter((link) => link.lineageId === parsed.lineageId),
  } satisfies ArtifactReferenceMetadata;
});

export const removeSessionLinks = Effect.fn("Artifacts.removeSessionLinks")(function* (
  sessionId: string,
) {
  yield* (yield* ArtifactStorage).removeTargetLinks({ type: "session", sessionId });
});

export const removeFamilyLinks = Effect.fn("Artifacts.removeFamilyLinks")(function* (
  familyId: string,
) {
  yield* (yield* ArtifactStorage).removeTargetLinks({ type: "family", familyId });
});
