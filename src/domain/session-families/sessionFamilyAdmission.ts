import { createHash } from "node:crypto";
import { ensureAdmittedSession as ensureSessionTodo } from "../projects/projectTodos";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import { childSessionStartup } from "./childSessionStartup";
import {
  ensureBoard,
  boardIdFor,
  append as appendBoardAssignment,
} from "../artifacts/messageBoards";
import { ChildSessionAssignment } from "../../contracts/project-sessions/child-session-assignment";
import { MessageBoardStorage } from "../../services/storage/MessageBoardStorage";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import { DateTime, Effect, Exit, Schema } from "effect";
import type { ChatConfiguration } from "../../contracts/conversations/session-contract";
import { PiModels } from "../../services/pi/PiModels";
import {
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
} from "../../services/pi/CakeSessionRuntimes";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import {
  SessionArchiveStorage,
  type SessionArchiveLocation,
} from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  familyChildren,
  familyDepth,
} from "../../contracts/session-families/session-family-document";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
  type CrossSessionContextSnapshot,
} from "../../contracts/conversations/cross-session-message";

const failure = (message: string) =>
  new SessionFamilyStorageError({ operation: "familyLifecycle", message });

/** Runs inside the same family lock as lifecycle and creation admission. */
const assertAdmission = Effect.fn("SessionFamilies.assertAdmission")(function* (
  sessionId: string,
  location: SessionArchiveLocation,
) {
  const storage = yield* SessionFamilyStorage;
  const family = yield* storage.familyForMember(sessionId);
  if (!family) return;
  if ((yield* resolutionNamespace(sessionId, location)) === "resolved")
    return yield* failure(
      `Restore the family explicitly from parent ${family.parentSessionId} before starting work`,
    );
});

export const admitTurn = Effect.fn("SessionFamilies.admitTurn")(function* <E, R>(
  sessionId: string,
  location: SessionArchiveLocation,
  input: { readonly turnId: string; readonly text: string },
  accept: Effect.Effect<void, E, R>,
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage.withMemberLock(
    sessionId,
    Effect.gen(function* () {
      yield* assertAdmission(sessionId, location);

      const request = parseCrossSessionMessage(input.text);
      const senderSessionId = request?.metadata.sender.sessionId;

      // A reply obligation belongs to this one message, never to the session
      // relationship: user-started turns and messages that asked for no
      // response are not journaled and therefore never produce notices.
      if (
        request &&
        request.metadata.expectsResponse &&
        !request.metadata.generatedNotice &&
        senderSessionId !== undefined
      )
        yield* storage.recordTurn({
          sessionId,
          senderSessionId,
          turnId: input.turnId,
          requestMessageId: request.metadata.messageId,
          threadId: request.metadata.threadId,
          reported: false,
          resultDelivery: request.metadata.resultDelivery ?? "notification",
        });
      yield* accept.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? storage.completeNotice(input.turnId) : Effect.void,
        ),
      );
    }),
  );
});

export const createChild = Effect.fn("SessionFamilies.createChild")(
  function* <E, R, E2 = never, R2 = never, E3 = never, R3 = never, E4 = never, R4 = never>(
    parentSessionId: string,
    location: ProjectSessionLocation,
    input: {
      requestId: string;
      title: string;
      assignment: ChildSessionAssignment;
      model: ChatConfiguration;
      resultDelivery?: ResultDelivery;
      worktreeName?: string;
      senderContext: CrossSessionContextSnapshot;
    },
    runtimeOptions: (
      sessionId: string,
      childLocation: ProjectSessionLocation,
      newSession: boolean,
    ) => Effect.Effect<CakeSessionRuntimeAcquireOptions, E, R>,
    createIsolatedLocation?: (
      worktreeName: string,
    ) => Effect.Effect<ProjectSessionLocation, E2, R2>,
    resolveLocation?: (workingDirectory: string) => Effect.Effect<ProjectSessionLocation, E3, R3>,
    discardIsolatedLocation?: (workingDirectory: string) => Effect.Effect<void, E4, R4>,
  ) {
    const storage = yield* SessionFamilyStorage;
    const sessions = yield* CakeSessionRuntimes;
    const models = yield* PiModels;
    const archive = yield* SessionArchiveStorage;
    const catalogs = yield* SessionCatalogChanges;
    // Validate even backend-direct callers before creating a reservation or runtime.
    const assignment = yield* Schema.decodeUnknownEffect(ChildSessionAssignment)(input.assignment);
    const configuration = yield* models.resolve(input.model);
    const archiveLocation = (workingDirectory: string) => ({
      cwd: workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
    });
    const publish = (sessionId: string, workingDirectory: string) =>
      catalogs.publish({
        _tag: "ProjectSessionChanged",
        sessionId,
        projectPath: location.projectPath,
        workingDirectory,
        resolved: false,
      });
    const childLocationFor = Effect.fn("SessionFamilies.childLocationFor")(function* (
      workingDirectory: string,
    ) {
      if (workingDirectory === location.workingDirectory) return location;
      if (resolveLocation) return yield* resolveLocation(workingDirectory);
      return yield* new SessionFamilyStorageError({
        operation: "createChild",
        message: `Child Working Directory unavailable: ${workingDirectory}`,
      });
    });
    const requestId = createHash("sha256")
      .update(JSON.stringify([parentSessionId, input.requestId]))
      .digest("hex");
    const prepared = yield* storage.withMemberLock(
      parentSessionId,
      Effect.gen(function* () {
        yield* assertAdmission(parentSessionId, archiveLocation(location.workingDirectory));
        const existing = yield* storage.familyForMember(parentSessionId);
        const retriedChild = existing?.children.find((item) => item.requestId === requestId);
        let childLocation = retriedChild
          ? yield* childLocationFor(retriedChild.workingDirectory)
          : location;
        if (!retriedChild && input.worktreeName) {
          if (!createIsolatedLocation)
            return yield* new SessionFamilyStorageError({
              operation: "createChild",
              message: "Isolated child worktree creation is unavailable",
            });
          childLocation = yield* createIsolatedLocation(input.worktreeName);
        }
        const childSessionId = crypto.randomUUID();
        const reservation = {
          familyId: existing?.familyId ?? crypto.randomUUID(),
          parentSessionId,
          parentWorkingDirectory: location.workingDirectory,
          childSessionId,
          assignmentTopic: `child-${childSessionId}`,
          childWorkingDirectory: childLocation.workingDirectory,
          resultDelivery: input.resultDelivery ?? "notification",
          requestId,
          projectPath: location.projectPath,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (location.managedWorktree)
          Object.assign(reservation, {
            parentManagedWorktreePath: location.managedWorktree.worktreePath,
          });
        if (childLocation.managedWorktree)
          Object.assign(reservation, {
            childManagedWorktreePath: childLocation.managedWorktree.worktreePath,
          });
        const family = yield* storage
          .addChild(reservation)
          .pipe(
            Effect.tapError(() =>
              !retriedChild &&
              childLocation.workingDirectory !== location.workingDirectory &&
              discardIsolatedLocation
                ? discardIsolatedLocation(childLocation.workingDirectory)
                : Effect.void,
            ),
          );
        const originatingSession = yield* sessions
          .catalogEntry(
            {
              workingDirectory: family.workingDirectory,
              sessionDirectory: location.sessionDirectory,
            },
            family.parentSessionId,
          )
          .pipe(Effect.catchTag("PiSessionError", () => Effect.succeed(undefined)));
        const child = family.children.find((item) => item.requestId === requestId);
        if (!child)
          return yield* new SessionFamilyStorageError({
            operation: "createChild",
            message: "Child reservation missing",
          });
        yield* publish(parentSessionId, location.workingDirectory);
        const assigned = yield* Effect.result(
          Effect.gen(function* () {
            if (!child.assignmentTopic)
              return yield* failure(
                "This is a bootstrap-first child; create a new assignment-first child instead",
              );
            yield* ensureBoard(family, originatingSession?.title);
            const boardId = boardIdFor(family.familyId);
            const previous = (yield* (yield* MessageBoardStorage).entries(boardId)).find(
              (entry) =>
                entry.topic === child.assignmentTopic && entry.authorSessionId === parentSessionId,
            );
            if (previous) {
              if (
                previous.description !== assignment.description ||
                previous.body !== assignment.body
              )
                return yield* failure(
                  "Retry must use the original assignment; publish later changes on the Workboard",
                );
              return { boardId, sequence: previous.sequence };
            }
            const posted = yield* appendBoardAssignment(parentSessionId, {
              ...assignment,
              audience: [child.sessionId],
              topic: child.assignmentTopic,
            });
            return { boardId, sequence: posted.entry.sequence };
          }),
        );
        if (assigned._tag === "Failure")
          return {
            family,
            child,
            childLocation,
            handle: undefined,
            error: String(assigned.failure),
            stage: "assignment" as const,
          };
        // A runtime or transcript alone is not evidence of initial-turn admission.
        // Any durable journal (including stopped/canceled work) forbids relaunch.
        const record = yield* (yield* RuntimeRecoveryStorage).get(child.sessionId);
        if (record) {
          yield* ensureSessionTodo(
            location.projectPath,
            child.sessionId,
            input.title,
            assignment.description,
          );
          return {
            family,
            child,
            childLocation,
            handle: undefined,
            assignmentReceipt: assigned.success,
            admissionState: record.state,
          };
        }
        const archived = yield* archive.locate(
          child.sessionId,
          archiveLocation(childLocation.workingDirectory),
        );
        const acquired = yield* Effect.result(
          Effect.gen(function* () {
            const handle = yield* sessions.acquire(
              yield* runtimeOptions(child.sessionId, childLocation, !archived),
            );
            yield* handle.applyConfiguration(configuration);
            yield* handle.rename(input.title);
            return handle;
          }),
        );
        if (acquired._tag === "Failure") {
          yield* publish(parentSessionId, location.workingDirectory);
          return {
            family,
            child,
            childLocation,
            handle: undefined,
            error: String(acquired.failure),
            stage: "runtime" as const,
            assignmentReceipt: assigned.success,
          };
        }
        return {
          family,
          child,
          childLocation,
          handle: acquired.success,
          assignmentReceipt: assigned.success,
        };
      }),
    );
    const identity = {
      familyId: prepared.family.familyId,
      parentSessionId,
      childSessionId: prepared.child.sessionId,
      workingDirectory: prepared.childLocation.workingDirectory,
      familyChildOrder: familyChildren(prepared.family, parentSessionId).findIndex(
        (child) => child.sessionId === prepared.child.sessionId,
      ),
      familyDepth: familyDepth(prepared.family, prepared.child.sessionId) ?? 0,
      resultDelivery: prepared.child.resultDelivery ?? "notification",
      requestId: input.requestId,
      assignment: prepared.assignmentReceipt,
    };
    if (!prepared.handle)
      return {
        ...identity,
        launch: prepared.error
          ? { status: "failed", stage: prepared.stage, message: prepared.error, retryable: true }
          : { status: "already-admitted", state: prepared.admissionState },
      };
    const assignmentTopic = prepared.child.assignmentTopic;
    if (!assignmentTopic)
      return yield* failure("Cannot render child startup without its persisted assignment topic");
    const initialMessage = encodeCrossSessionMessage(
      childSessionStartup({
        familyId: identity.familyId,
        childSessionId: identity.childSessionId,
        parentSessionId,
        rootSessionId: prepared.family.parentSessionId,
        workingDirectory: identity.workingDirectory,
        resultDelivery: identity.resultDelivery,
        assignmentReceipt: prepared.assignmentReceipt,
        assignmentTopic,
        assignment,
      }),
      {
        version: 1,
        messageId: prepared.child.sessionId,
        threadId: prepared.family.familyId,
        sequence: 1,
        expectsResponse: identity.resultDelivery !== "ignore",
        resultDelivery: identity.resultDelivery,
        context: input.senderContext,
        sender: {
          sessionId: parentSessionId,
          title: `Parent session ${parentSessionId}`,
          kind: "project-session",
          projectName: location.projectName,
          workingDirectory: location.workingDirectory,
        },
      },
    );
    const handle = prepared.handle;
    const launched = yield* Effect.result(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const turnId = yield* restore(handle.prompt(initialMessage, [], false));
          yield* ensureSessionTodo(
            location.projectPath,
            prepared.child.sessionId,
            input.title,
            input.assignment.description,
          );
          return turnId;
        }),
      ),
    );
    if (launched._tag === "Failure") {
      return {
        ...identity,
        launch: {
          status: "failed",
          stage: "admission",
          message: String(launched.failure),
          retryable: true,
        },
      };
    }
    yield* publish(prepared.child.sessionId, prepared.childLocation.workingDirectory);
    return { ...identity, launch: { status: "accepted", turnId: launched.success } };
  },
  (effect, parentSessionId, _location, input) =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      return yield* storage.withCreationLock(
        JSON.stringify([parentSessionId, input.requestId]),
        effect,
      );
    }),
);
