import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { expect } from "vitest";
import { observeProjectActivity } from "../../../src/domain/projects/projectActivity";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import {
  SubagentCoordinator,
  SubagentCoordinatorLive,
  type SubagentHandleState,
} from "../../../src/services/subagents/SubagentCoordinator";
import type { SubagentError, SubagentResult } from "../../../src/contracts/subagents/subagent-data";
import { options } from "../helpers/piRuntimeFixture";
import {
  makeSubagentStorageTestLayer,
  subagentHistoryFixture,
} from "../helpers/subagentStorageFixture";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { projectRecord } from "../renderer/fixtures/catalog-fixtures";

it.effect(
  "projects live side-chat activity through managed worktrees without reading saved sessions",
  () =>
    Effect.gen(function* () {
      let directories: readonly string[] = [];
      yield* Effect.gen(function* () {
        const state = (yield* SubagentCoordinator).state;
        const changes = yield* SessionCatalogChanges;
        const received = yield* Queue.unbounded<readonly string[]>();
        const observer = yield* (yield* observeProjectActivity()).pipe(
          Stream.runForEach((paths) => Queue.offer(received, paths)),
          Effect.forkChild,
        );
        expect(yield* Queue.take(received)).toEqual([]);
        directories = ["/managed/cake"];
        const change = {
          _tag: "DiscussionSessionActivityChanged" as const,
          sessionId: "nested-sidecar",
          parentSessionId: "hidden-parent",
          workingDirectory: "/managed/cake",
          sessionDirectory: "/sidecars",
        };
        yield* changes.publish(change);
        expect(yield* Queue.take(received)).toEqual(["/cake"]);
        // Token-only coordinator revisions cannot republish the dot or inspect history.
        for (let revision = 1; revision <= 5; revision++)
          yield* SubscriptionRef.update(state, (current) => ({ ...current, revision }));
        directories = [];
        yield* changes.publish(change);
        expect(yield* Queue.take(received)).toEqual([]);
        const history = subagentHistoryFixture({
          workingDirectory: "/managed/cake",
          parentSessionId: "nested-sidecar",
        });
        const handle: SubagentHandleState = {
          ...history,
          recovery: {
            ...history,
            parentProfile: "ProjectSession",
            parentSessionDirectory: "/sessions",
            allowMutations: false,
            tools: [],
            inputReferences: [],
            messageReferences: [],
            notifyOnCompletion: false,
            completionId: "completion",
            completionDisposition: "pending",
            pendingInputs: [],
          },
          tools: [],
          scope: yield* Scope.make(),
          completion: yield* Deferred.make<SubagentResult, SubagentError>(),
          runtimeOptions: options(),
          inputReferences: [],
          messageReferences: [],
          status: "queued",
          activityRevision: 0,
          streaming: false,
          parts: [],
          waiters: 0,
          completionDisposition: "pending",
        };
        yield* SubscriptionRef.update(state, (current) => ({
          revision: current.revision + 1,
          handles: new Map([[handle.handleId, handle]]),
        }));
        expect(yield* Queue.take(received)).toEqual(["/cake"]);
        for (let revision = 1; revision <= 5; revision++)
          yield* SubscriptionRef.update(state, (current) => ({
            revision: current.revision + 1,
            handles: new Map([
              [
                handle.handleId,
                { ...handle, status: "running" as const, activityRevision: revision },
              ],
            ]),
          }));
        yield* SubscriptionRef.update(state, (current) => ({
          revision: current.revision + 1,
          handles: new Map([[handle.handleId, { ...handle, status: "complete" as const }]]),
        }));
        expect(yield* Queue.take(received)).toEqual([]);
        yield* Scope.close(handle.scope, Exit.void);
        yield* Fiber.interrupt(observer);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            SessionCatalogChanges.layer,
            SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
            Layer.mock(ApplicationState, {
              snapshot: () => ({
                ...defaultApplicationState(),
                projects: [projectRecord({ path: "/cake" })],
              }),
              changes: () => Stream.never,
            }),
            Layer.mock(CakeSessionRuntimes, {
              activeWorkingDirectories: () => Effect.sync(() => directories),
            }),
            Layer.mock(ManagedWorktrees, {
              records: () =>
                Effect.succeed([
                  {
                    projectPath: "/cake",
                    worktreePath: "/managed/cake",
                    branch: "task",
                    baseBranch: "main",
                    createdAt: "2026-01-01T00:00:00Z",
                  },
                ]),
            }),
          ),
        ),
      );
    }),
);
