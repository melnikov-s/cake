import { Effect, Layer } from "effect";
import { projectReviewThread, type ReviewThreadRecord } from "../ipc/review-contract";
import { ReviewStorage } from "../services/storage/ReviewStorage";
import { ApplicationState } from "../services/storage/ApplicationState";
import {
  reviewSidecarSystemPrompt,
  writeDiscussionParentContext,
} from "../services/pi/runtime/sidecar-runtime";
import {
  DiscussionSessionEnvironmentError,
  makeDiscussionSessionEnvironmentLayer,
  type DiscussionSessionRecord,
} from "../services/discussion-sessions/DiscussionSessionEnvironment";

export interface DiscussionSessionEnvironmentLiveOptions {
  readonly agentDirectory: string;
  readonly parentSessionDirectory: string;
}

const environmentError = (operation: string, cause: unknown) =>
  new DiscussionSessionEnvironmentError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const projectRecord = (record: ReviewThreadRecord | undefined): DiscussionSessionRecord => {
  if (!record) throw new Error("That Discussion Session no longer exists");
  const projected: DiscussionSessionRecord = {
    id: record.id,
    workingDirectory: record.workspacePath,
    parentSessionId: record.sessionId,
    pendingParts: projectReviewThread(record).parts,
    anchor: record.anchor,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.agentSessionId !== undefined)
    Object.assign(projected, { sidecarSessionId: record.agentSessionId });
  if (record.agentSessionFile !== undefined)
    Object.assign(projected, { sidecarSessionFile: record.agentSessionFile });
  if (record.resolvedAt !== undefined) Object.assign(projected, { resolvedAt: record.resolvedAt });
  return projected;
};

export const makeDiscussionSessionEnvironmentLive = (
  options: DiscussionSessionEnvironmentLiveOptions,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const storage = yield* ReviewStorage;
      const application = yield* ApplicationState;
      return makeDiscussionSessionEnvironmentLayer({
        list: Effect.fn("DiscussionSessionEnvironment.list")(
          function* (workingDirectory, parentSessionId) {
            return yield* storage.listDiscussionRecords(workingDirectory, parentSessionId).pipe(
              Effect.map((records) => records.map(projectRecord)),
              Effect.mapError((cause) => environmentError("list", cause)),
            );
          },
        ),
        get: Effect.fn("DiscussionSessionEnvironment.get")(
          function* (workingDirectory, parentSessionId, threadId) {
            return yield* storage.get(workingDirectory, parentSessionId, threadId).pipe(
              Effect.map(projectRecord),
              Effect.mapError((cause) => environmentError("get", cause)),
            );
          },
        ),
        create: Effect.fn("DiscussionSessionEnvironment.create")(
          function* (workingDirectory, parentSessionId, anchor) {
            return yield* storage.createDiscussion(workingDirectory, parentSessionId, anchor).pipe(
              Effect.map(projectRecord),
              Effect.mapError((cause) => environmentError("create", cause)),
            );
          },
        ),
        linkSidecar: Effect.fn("DiscussionSessionEnvironment.linkSidecar")((record, sidecar) =>
          storage
            .linkDiscussionSidecar(
              record.workingDirectory,
              record.parentSessionId,
              record.id,
              sidecar,
            )
            .pipe(
              Effect.map(projectRecord),
              Effect.mapError((cause) => environmentError("linkSidecar", cause)),
            ),
        ),
        setResolved: Effect.fn("DiscussionSessionEnvironment.setResolved")(
          function* (record, resolved) {
            yield* storage
              .resolve(record.workingDirectory, record.parentSessionId, record.id, resolved)
              .pipe(Effect.mapError((cause) => environmentError("setResolved", cause)));
            return yield* storage
              .get(record.workingDirectory, record.parentSessionId, record.id)
              .pipe(
                Effect.map(projectRecord),
                Effect.mapError((cause) => environmentError("setResolved", cause)),
              );
          },
        ),
        location: Effect.fn("DiscussionSessionEnvironment.location")(function* (record) {
          const sessionDirectory = yield* storage.agentSessionDirectory(
            record.workingDirectory,
            record.parentSessionId,
            record.id,
          );
          return {
            agentDirectory: options.agentDirectory,
            sessionDirectory,
            parentSessionDirectory: options.parentSessionDirectory,
            trusted: application.snapshot().trustedProjectPaths.includes(record.workingDirectory),
          };
        }),
        prepareParentContext: Effect.fn("DiscussionSessionEnvironment.prepareParentContext")(
          function* (record, parent) {
            const stored = yield* storage
              .get(record.workingDirectory, record.parentSessionId, record.id)
              .pipe(Effect.mapError((cause) => environmentError("prepareParentContext", cause)));
            if (!stored)
              return yield* new DiscussionSessionEnvironmentError({
                operation: "prepareParentContext",
                message: "That Discussion Session no longer exists",
              });
            const target = yield* storage.discussionParentContextPath(
              record.workingDirectory,
              record.parentSessionId,
              record.id,
            );
            const path = yield* Effect.tryPromise({
              try: () =>
                writeDiscussionParentContext({
                  cwd: record.workingDirectory,
                  parentSessionRoot: options.parentSessionDirectory,
                  parent,
                  target,
                }),
              catch: (cause) => environmentError("prepareParentContext", cause),
            });
            return reviewSidecarSystemPrompt(stored, path);
          },
        ),
        refreshParentIndex: Effect.fn("DiscussionSessionEnvironment.refreshParentIndex")(
          function* (record) {
            yield* storage
              .refreshDiscussionContext(record.workingDirectory, record.parentSessionId)
              .pipe(Effect.mapError((cause) => environmentError("refreshParentIndex", cause)));
          },
        ),
      });
    }),
  );
