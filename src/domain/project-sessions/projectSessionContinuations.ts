import { Effect, Stream } from "effect";
import { getState } from "../application/application";
import * as projectSessionLocations from "./projectSessionLocations";
import type { ProjectSessionLocation } from "./project-session-data";
import { ProjectSessionError, type ProjectSessionTarget } from "./project-session-data";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  archiveLocation,
  asError,
  catalogForState,
  findLocation,
  nextCopyTitle,
  publishCatalogChange,
} from "./projectSessionMetadata";
import { acquireTarget, prompt } from "./projectSessionOperations";
import { resolve, restore } from "./projectSessionLifecycle";

const withContinuationSource = Effect.fn("ProjectSessions.withContinuationSource")(function* <
  A,
  E,
  R,
>(
  target: ProjectSessionTarget,
  operation: "fork",
  use: (location: ProjectSessionLocation) => Effect.Effect<A, E, R>,
) {
  const source = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(source))
    .pipe(asError(operation));
  if (namespace !== "resolved")
    return { result: yield* use(source), source, sourceWasResolved: false };

  // Resolved transcripts are read-only. Move the source back only for the
  // duration of the copy operation, then archive it again without publishing
  // an intermediate active state. The new transcript stays in the active
  // namespace while the source remains resolved from the user's perspective.
  const restored = yield* projectSessionLocations
    .restore(target.sessionId, source)
    .pipe(asError(operation));
  const result = yield* use(restored).pipe(
    Effect.ensuring(
      projectSessionLocations
        .archive(target.sessionId, restored)
        .pipe(asError(operation), Effect.orDie),
    ),
  );
  return { result, source: restored, sourceWasResolved: true };
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
  const continuation = yield* withContinuationSource(input.target, "fork", (source) =>
    Effect.gen(function* () {
      const state = yield* getState();
      const projectCatalogs = yield* Effect.all(
        [false, true].map((resolved) =>
          catalogForState({ projectPath: source.projectPath, resolved }, state).pipe(
            Effect.flatMap(Stream.runCollect),
          ),
        ),
      );
      const projectSessions = projectCatalogs.flatMap((catalog) => Array.from(catalog));
      const sourceTitle =
        projectSessions.find(
          (session) =>
            session.sessionId === input.target.sessionId &&
            session.workingDirectory === source.workingDirectory,
        )?.title ?? input.target.sessionId;
      const forkTitle = nextCopyTitle(
        sourceTitle,
        new Set(projectSessions.map((session) => session.title)),
      );

      let destination = source;
      let sessionId: string;
      if (
        input.destinationWorkingDirectory === undefined ||
        input.destinationWorkingDirectory === source.workingDirectory
      ) {
        const handle = yield* acquireTarget(source, input.target.sessionId, false);
        const result = yield* handle.fork(input.entryId, forkTitle).pipe(asError("fork"));
        sessionId = result.sessionId;
      } else {
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
        sessionId = yield* projectSessionLocations
          .forkToWorkingDirectory({
            sessionId: input.target.sessionId,
            entryId: input.entryId,
            title: forkTitle,
            source,
            destination: selectedDestination,
          })
          .pipe(asError("fork"));
        destination = selectedDestination;
      }
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
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(input.target.sessionId, archiveLocation(source))
    .pipe(asError("toolCompact"));
  if (namespace === "resolved") {
    yield* restore(input.target);
    source = yield* findLocation(input.target);
  }

  const handle = yield* acquireTarget(source, input.target.sessionId, false);
  const result = yield* handle.toolCompact(input.entryId).pipe(asError("toolCompact"));
  const continuationPrompt = input.prompt?.trim();
  if (continuationPrompt)
    yield* prompt({
      sessionId: result.sessionId,
      workingDirectory: source.workingDirectory,
      text: continuationPrompt,
      attachments: [],
      renderUserMessageAsMarkdown: false,
    });
  else yield* publishCatalogChange(result.sessionId, source, false);
  return { sessionId: result.sessionId };
});
