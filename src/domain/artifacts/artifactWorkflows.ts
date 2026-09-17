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
  type ArtifactRevisionNumber,
  type ArtifactStableRef,
  formatArtifactRef,
  parseArtifactRef,
} from "./artifact-lineage";

export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()("ArtifactNotFound", {
  lineageId: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
}) {}

export class ArtifactNotLinked extends Schema.TaggedError<ArtifactNotLinked>()(
  "ArtifactNotLinked",
  {
    sessionId: Schema.String,
    lineageId: Schema.String,
  },
) {}

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

export const historyForSession = Effect.fn("Artifacts.historyForSession")(function* (
  sessionId: string,
  lineageId: ArtifactLineageId,
) {
  yield* requireEffectiveLink(sessionId, lineageId);
  return yield* history(lineageId);
});

export const resolveEffectiveReference = Effect.fn("Artifacts.resolveEffectiveReference")(
  function* (sessionId: string, reference: ArtifactStableRef) {
    const parsed = parseArtifactRef(reference);
    const link = yield* requireEffectiveLink(sessionId, parsed.lineageId);
    const storage = yield* ArtifactStorage;
    const catalog = yield* storage.catalog();
    const lineage = yield* requireLineage(catalog, parsed.lineageId);
    // URI semantics are independent from the visibility link's selected projection:
    // stable refs always follow latest and exact refs always select their named revision.
    const selectedRevision = parsed.revision ?? lineage.latestRevision;
    const value = yield* storage.read(parsed.lineageId, selectedRevision);
    if (!value)
      return yield* new ArtifactNotFound({
        lineageId: parsed.lineageId,
        revision: selectedRevision,
      });
    return { revision: value, link, latestRevision: lineage.latestRevision };
  },
);

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

export const linkForSession = Effect.fn("Artifacts.linkForSession")(function* (
  lineageId: ArtifactLineageId,
  sessionId: string,
  selection: ArtifactLink["selection"] = { mode: "follow-latest" },
) {
  const families = yield* SessionFamilyStorage;
  yield* families.withMemberLock(
    sessionId,
    Effect.gen(function* () {
      const familyTarget = yield* familyTargetForSession(sessionId);
      yield* putLink(lineageId, familyTarget ?? { type: "session", sessionId }, selection);
    }),
  );
});

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

/** Removes the direct link when present, otherwise the effective family link. */
export const unlinkEffectiveSessionArtifact = Effect.fn("Artifacts.unlinkEffectiveSessionArtifact")(
  function* (sessionId: string, lineageId: ArtifactLineageId) {
    const link = yield* requireEffectiveLink(sessionId, lineageId);
    yield* (yield* ArtifactStorage).removeLink(link.target, lineageId);
  },
);

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

export const searchGlobalLineages = Effect.fn("Artifacts.searchGlobalLineages")(function* (input?: {
  readonly search?: string;
  readonly offset?: number;
  readonly limit?: number;
}) {
  const catalog = yield* (yield* ArtifactStorage).catalog();
  const search = input?.search?.trim().toLocaleLowerCase();
  const offset = Math.max(0, input?.offset ?? 0);
  const limit = Math.min(100, Math.max(1, input?.limit ?? 50));
  const storage = yield* ArtifactStorage;
  const summaries = (yield* Effect.forEach(
    catalog.lineages,
    Effect.fn("Artifacts.summarizeLineage")(function* (lineage) {
      const latest = lineage.revisions.find(
        (revision) => revision.revision === lineage.latestRevision,
      )!;
      const value = yield* storage.read(lineage.id, lineage.latestRevision);
      return {
        id: lineage.id,
        createdAt: lineage.createdAt,
        latestRevision: lineage.latestRevision,
        latest,
        ...(value?.snapshot.title === undefined ? null : { title: value.snapshot.title }),
        stableRef: formatArtifactRef({ lineageId: lineage.id }),
      };
    }),
  ))
    .filter((summary) => {
      if (!search) return true;
      return (
        summary.id.toLocaleLowerCase().includes(search) ||
        summary.title?.toLocaleLowerCase().includes(search) ||
        summary.latest.kind.toLocaleLowerCase().includes(search)
      );
    })
    .toSorted((left, right) => right.latest.publishedAt.localeCompare(left.latest.publishedAt));
  return {
    items: summaries.slice(offset, offset + limit),
    offset,
    limit,
    total: summaries.length,
    hasMore: offset + limit < summaries.length,
  };
});

export const listGlobalLineages = Effect.fn("Artifacts.listGlobalLineages")(function* () {
  return (yield* (yield* ArtifactStorage).catalog()).lineages;
});

export const lineageDetail = Effect.fn("Artifacts.lineageDetail")(function* (
  lineageId: ArtifactLineageId,
) {
  const catalog = yield* (yield* ArtifactStorage).catalog();
  const lineage = yield* requireLineage(catalog, lineageId);
  const latest = lineage.revisions.find(
    (revision) => revision.revision === lineage.latestRevision,
  )!;
  const value = yield* (yield* ArtifactStorage).read(lineage.id, lineage.latestRevision);
  return {
    lineage: {
      id: lineage.id,
      createdAt: lineage.createdAt,
      latestRevision: lineage.latestRevision,
      latest,
      ...(value?.snapshot.title === undefined ? null : { title: value.snapshot.title }),
      stableRef: formatArtifactRef({ lineageId }),
    },
    links: catalog.links.filter((link) => link.lineageId === lineageId),
    stableRef: formatArtifactRef({ lineageId }),
  };
});

export const paginatedHistory = Effect.fn("Artifacts.paginatedHistory")(function* (
  lineageId: ArtifactLineageId,
  offset = 0,
  requestedLimit = 50,
) {
  const revisions = [...(yield* history(lineageId))].toSorted(
    (left, right) => right.metadata.revision - left.metadata.revision,
  );
  const boundedOffset = Math.max(0, offset);
  const limit = Math.min(100, Math.max(1, requestedLimit));
  return {
    items: revisions.slice(boundedOffset, boundedOffset + limit).map(({ metadata }) => metadata),
    offset: boundedOffset,
    limit,
    total: revisions.length,
    hasMore: boundedOffset + limit < revisions.length,
  };
});

export const compareText = Effect.fn("Artifacts.compareText")(function* (
  lineageId: ArtifactLineageId,
  fromRevision: ArtifactRevisionNumber,
  toRevision: ArtifactRevisionNumber,
) {
  const [from, to] = yield* Effect.all([
    readExactRevision(lineageId, fromRevision),
    readExactRevision(lineageId, toRevision),
  ]);
  return {
    lineageId,
    fromRevision,
    toRevision,
    fromText: from.snapshot.fallback.markdown,
    toText: to.snapshot.fallback.markdown,
  };
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
  const latest = lineage.revisions.find(
    (candidate) => candidate.revision === lineage.latestRevision,
  )!;
  const latestValue = yield* (yield* ArtifactStorage).read(lineage.id, lineage.latestRevision);
  const stableRef = formatArtifactRef({ lineageId: parsed.lineageId });
  return {
    lineage: {
      id: lineage.id,
      createdAt: lineage.createdAt,
      latestRevision: lineage.latestRevision,
      latest,
      ...(latestValue?.snapshot.title === undefined ? null : { title: latestValue.snapshot.title }),
      stableRef,
    },
    revision,
    links: catalog.links.filter((link) => link.lineageId === parsed.lineageId),
    stableRef,
    exactRef: formatArtifactRef({ lineageId: parsed.lineageId, revision: revisionNumber }),
  };
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
