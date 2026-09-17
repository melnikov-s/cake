import { Effect, Schema, Stream } from "effect";
import type { ArtifactPointer } from "../../ipc/artifact-contract";
import { ArtifactLineageId, ArtifactRevisionNumber } from "../artifacts/artifact-lineage";
import * as artifactWorkflows from "../artifacts/artifactWorkflows";
import * as projectSessionLocations from "./projectSessionLocations";
import { resolutionNamespace } from "./projectSessionResolution";
import type { ProjectSessionLocation } from "./project-session-data";
import { ProjectSessionError, type ProjectSessionTarget } from "./project-session-data";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { PiSessions } from "../../services/pi/PiSessions";
import {
  archiveLocation,
  asError,
  findLocation,
  nextCopyTitle,
  publishCatalogChange,
} from "./projectSessionMetadata";
import { acquireTarget } from "./projectSessionOperations";
import * as sessionChats from "../conversations/sessionChats";
import { resolve, restore } from "./projectSessionLifecycle";

const withContinuationSource = Effect.fn("ProjectSessions.withContinuationSource")(function* <
  A,
  E,
  R,
>(
  target: ProjectSessionTarget,
  operation: "fork",
  use: (location: ProjectSessionLocation, archived: boolean) => Effect.Effect<A, E, R>,
) {
  const source = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(source))
    .pipe(asError(operation));
  const effective = yield* resolutionNamespace(target.sessionId, archiveLocation(source)).pipe(
    asError(operation),
  );
  // Read archived sources in place. Temporarily moving a family root would
  // temporarily change the lifecycle authority for all of its descendants.
  return {
    result: yield* use(source, namespace === "resolved"),
    source,
    sourceWasResolved: effective === "resolved",
  };
});

export const fork = Effect.fn("ProjectSessions.fork")(function* (input: {
  readonly target: ProjectSessionTarget;
  readonly entryId: string;
  readonly destinationWorkingDirectory?: string;
  readonly resolveSource?: boolean;
}) {
  const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
    storage.familyForMember(input.target.sessionId),
  ).pipe(asError("fork"));
  if (family && input.resolveSource)
    return yield* new ProjectSessionError({
      operation: "fork",
      message: "Forks from Session Family members must leave the source family active",
    });
  const continuation = yield* withContinuationSource(input.target, "fork", (source, archived) =>
    Effect.gen(function* () {
      let destination = source;
      if (
        input.destinationWorkingDirectory !== undefined &&
        input.destinationWorkingDirectory !== source.workingDirectory
      ) {
        const locations = yield* projectSessionLocations.locations().pipe(asError("fork"));
        const selectedDestination = locations.find(
          (item) => item.workingDirectory === input.destinationWorkingDirectory,
        );
        if (!selectedDestination)
          return yield* new ProjectSessionError({
            operation: "fork",
            message: "Cake could not find the destination Working Directory",
          });
        if (selectedDestination.projectPath !== source.projectPath)
          return yield* new ProjectSessionError({
            operation: "fork",
            message: "The source and destination belong to different Projects",
          });
        destination = selectedDestination;
      }

      const sessions = yield* PiSessions;
      const archive = yield* SessionArchiveStorage;
      const titleLocations =
        destination.workingDirectory === source.workingDirectory ? [source] : [source, destination];
      const catalogTitles = yield* Effect.all(
        titleLocations.map((location) =>
          Effect.all(
            {
              active: sessions
                .catalog({
                  workingDirectory: location.workingDirectory,
                  sessionDirectory: location.sessionDirectory,
                })
                .pipe(Stream.runCollect, asError("fork")),
              resolved: archive
                .resolved(archiveLocation(location))
                .pipe(Stream.runCollect, asError("fork")),
            },
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(({ active, resolved }) =>
              [...active, ...resolved].map((item) => item.title),
            ),
          ),
        ),
        { concurrency: "unbounded" },
      );
      const sourceTitle = yield* sessions
        .catalogEntry(
          {
            workingDirectory: source.workingDirectory,
            sessionDirectory: archived ? source.resolvedSessionDirectory : source.sessionDirectory,
          },
          input.target.sessionId,
        )
        .pipe(
          asError("fork"),
          Effect.map((entry) => entry?.title ?? input.target.sessionId),
        );
      const forkTitle = nextCopyTitle(sourceTitle, new Set(catalogTitles.flat()));

      let sessionId: string;
      let artifactPointers: ReadonlyArray<ArtifactPointer>;
      if (destination === source && !archived) {
        const handle = yield* acquireTarget(source, input.target.sessionId, false);
        const result = yield* handle.fork(input.entryId, forkTitle).pipe(asError("fork"));
        sessionId = result.sessionId;
        artifactPointers = result.artifactPointers;
      } else {
        const result = yield* projectSessionLocations
          .forkToWorkingDirectory({
            sessionId: input.target.sessionId,
            entryId: input.entryId,
            title: forkTitle,
            source: archived
              ? { ...source, sessionDirectory: source.resolvedSessionDirectory }
              : source,
            destination,
          })
          .pipe(asError("fork"));
        sessionId = result.sessionId;
        artifactPointers = result.artifactPointers;
      }
      const artifactStorage = yield* ArtifactStorage;
      yield* Effect.forEach(
        artifactPointers,
        Effect.fn("ProjectSessions.linkForkArtifact")(function* (pointer) {
          const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(
            pointer.artifactId,
          ).pipe(asError("fork"));
          const revision = yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
            pointer.revision,
          ).pipe(asError("fork"));
          const stored = yield* artifactStorage.read(lineageId, revision).pipe(asError("fork"));
          if (!stored || stored.metadata.digest !== pointer.digest)
            return yield* new ProjectSessionError({
              operation: "fork",
              message: `Artifact ${pointer.artifactId}@r${pointer.revision} does not match storage`,
            });
          yield* artifactWorkflows
            .linkSession(lineageId, sessionId, { mode: "pinned", revision })
            .pipe(asError("fork"));
        }),
        { discard: true },
      );
      return { sessionId, destination };
    }),
  );
  if (input.resolveSource && !continuation.sourceWasResolved) yield* resolve(input.target);
  yield* publishCatalogChange(
    continuation.result.sessionId,
    continuation.result.destination,
    false,
  );
  return { sessionId: continuation.result.sessionId };
});

export const toolCompact = Effect.fn("ProjectSessions.toolCompact")(function* (input: {
  readonly target: ProjectSessionTarget;
  readonly entryId: string;
  readonly prompt?: string;
}) {
  let source = yield* findLocation(input.target);
  const namespace = yield* resolutionNamespace(
    input.target.sessionId,
    archiveLocation(source),
  ).pipe(asError("toolCompact"));
  if (namespace === "resolved") {
    yield* restore(input.target);
    source = yield* findLocation(input.target);
  }

  const handle = yield* acquireTarget(source, input.target.sessionId, false);
  const result = yield* handle.toolCompact(input.entryId).pipe(asError("toolCompact"));
  const continuationPrompt = input.prompt?.trim();
  if (continuationPrompt)
    yield* sessionChats
      .deliver(
        {
          sessionId: result.sessionId,
          text: continuationPrompt,
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        "prompt",
      )
      .pipe(asError("toolCompact"));
  else yield* publishCatalogChange(result.sessionId, source, false);
  return { sessionId: result.sessionId };
});
