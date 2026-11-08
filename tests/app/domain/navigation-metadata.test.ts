import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Scope, Stream, SubscriptionRef } from "effect";
import { expect } from "vitest";
import {
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { SubagentError, SubagentResult } from "../../../src/contracts/subagents/subagent-data";
import * as subagentObservation from "../../../src/domain/subagents/subagentObservation";
import * as discussions from "../../../src/domain/discussion-sessions/discussionSessions";
import * as cakeChatMetadata from "../../../src/domain/cake-chats/cakeChatMetadata";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { projectRecord } from "../renderer/fixtures/catalog-fixtures";
import {
  SubagentCoordinator,
  SubagentCoordinatorLive,
  type SubagentHandleState,
} from "../../../src/services/subagents/SubagentCoordinator";
import {
  DiscussionSessionEnvironment,
  type DiscussionSessionRecord,
} from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import type { SubagentRecord } from "../../../src/services/storage/SubagentStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import {
  makeSubagentStorageTestLayer,
  subagentHistoryFixture,
} from "../helpers/subagentStorageFixture";

it.effect(
  "Project Chat catalog reports running and idle without opening or inspecting its transcript",
  () => {
    let running = true;
    const location = { workingDirectory: "/cake", sessionDirectory: "/cake/chats" };
    return Effect.gen(function* () {
      const active = yield* cakeChatMetadata.catalog(location);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ projectPath: "/other", running: true });
      running = false;
      expect((yield* cakeChatMetadata.catalog(location))[0]).toMatchObject({
        projectPath: "/other",
        running: false,
      });
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ApplicationState, {
            snapshot: () => ({
              ...defaultApplicationState(),
              projects: [projectRecord({ path: "/other" })],
            }),
          }),
          Layer.mock(CakeSessionRuntimes, {
            catalogEntry: () => Effect.succeed(undefined),
            currentStatus: () =>
              Effect.succeed({ streaming: running, pending: false, persisted: false }),
            acquire: () => Effect.die("Catalog activity must not acquire a runtime"),
            inspect: () => Effect.die("Catalog activity must not inspect a transcript"),
          }),
        ),
      ),
    );
  },
);

it.effect(
  "cold Subagent metadata does not hydrate Pi; full observation still obtains the retained transcript",
  () =>
    Effect.gen(function* () {
      const coordinator = yield* SubagentCoordinator;
      const history = subagentHistoryFixture();
      const recovery: SubagentRecord = {
        ...history,
        parentProfile: "ProjectSession",
        parentSessionDirectory: "/primary",
        allowMutations: true,
        tools: [],
        inputReferences: [],
        messageReferences: [],
        notifyOnCompletion: false,
        completionId: "completion",
        completionDisposition: "notified",
        pendingInputs: [],
      };
      let hydrations = 0;
      let activityRevision = 1;
      let parts: SubagentHandleState["parts"] = [];
      const handle: SubagentHandleState = {
        handleId: history.handleId,
        recovery,
        parentSessionId: history.parentSessionId,
        anchorPartId: history.anchorPartId,
        workingDirectory: history.workingDirectory,
        task: history.task,
        resolvedModel: history.resolvedModel,
        tools: [],
        fastMode: false,
        scope: yield* Scope.make(),
        completion: yield* Deferred.make<SubagentResult, SubagentError>(),
        get runtimeOptions(): CakeSessionRuntimeAcquireOptions {
          throw new Error("Metadata must not construct runtime options");
        },
        inputReferences: [],
        messageReferences: [],
        status: "complete",
        get activityRevision() {
          return activityRevision;
        },
        streaming: false,
        get parts() {
          return parts;
        },
        waiters: 0,
        completionDisposition: "notified",
        hydrate: Effect.gen(function* () {
          hydrations++;
          activityRevision++;
          parts = [
            {
              id: "retained-original",
              kind: "text",
              role: "assistant",
              text: "Actual retained worker transcript",
              status: "complete",
            },
          ];
          yield* SubscriptionRef.update(coordinator.state, (state) => ({
            ...state,
            revision: state.revision + 1,
          }));
        }),
      };
      yield* SubscriptionRef.update(coordinator.state, (state) => ({
        ...state,
        handles: new Map([[history.handleId, handle]]),
      }));
      const metadata = yield* (yield* subagentObservation.observeMetadata(
        history.parentSessionId,
      )).pipe(Stream.runHead);
      expect(hydrations).toBe(0);
      expect(metadata._tag).toBe("Some");
      if (metadata._tag === "Some") {
        expect(metadata.value).toEqual([
          {
            parentSessionId: history.parentSessionId,
            handleId: history.handleId,
            anchorPartId: history.anchorPartId,
            task: history.task,
            status: "complete",
            streaming: false,
            released: false,
            resolved: false,
          },
        ]);
        expect(JSON.stringify(metadata.value)).not.toContain(history.privateSessionId);
        expect(JSON.stringify(metadata.value)).not.toContain("parts");
      }
      const full = yield* (yield* subagentObservation.observe(history.parentSessionId)).pipe(
        Stream.filter((update) =>
          update._tag === "Snapshot"
            ? update.activities.some((activity) => activity.parts.length > 0)
            : update._tag === "Activity" && update.activity.parts.length > 0,
        ),
        Stream.runHead,
      );
      expect(hydrations).toBe(1);
      expect(JSON.stringify(full)).toContain("Actual retained worker transcript");
    }).pipe(
      Effect.provide(
        Layer.merge(
          SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
          Layer.mock(CakeSessionRuntimes, {
            inspect: () => Effect.die("Metadata must not inspect history"),
          }),
        ),
      ),
    ),
);

it.effect("released worker metadata reads ownership records, never historical Pi parts", () => {
  const record = subagentHistoryFixture();
  return Effect.gen(function* () {
    const value = yield* (yield* subagentObservation.observeMetadata(record.parentSessionId)).pipe(
      Stream.runHead,
    );
    expect(value._tag).toBe("Some");
    if (value._tag === "Some") {
      expect(value.value[0]).toMatchObject({
        handleId: record.handleId,
        task: record.task,
        released: true,
        resolved: true,
      });
      expect(JSON.stringify(value.value)).not.toContain("parts");
      expect(JSON.stringify(value.value)).not.toContain(record.privateSessionId);
    }
  }).pipe(
    Effect.provide(
      SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer([], [record]))),
    ),
  );
});

it.effect(
  "cold Discussion metadata lists real saved owners without inspecting any sidecar parts",
  () => {
    const record: DiscussionSessionRecord = {
      id: "thread",
      workingDirectory: "/project",
      parentSessionId: "cold-parent",
      sidecarSessionId: "sidecar",
      pendingParts: [],
      anchor: {
        path: "message",
        view: "message",
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "Review navigation",
        contextBefore: "",
        contextAfter: "",
        diff: "",
      },
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    return Effect.gen(function* () {
      const metadata = yield* (yield* discussions.observeMetadata({
        workingDirectory: "/project",
        parentSessionId: "cold-parent",
      })).pipe(Stream.runHead);
      expect(metadata._tag).toBe("Some");
      if (metadata._tag === "Some")
        expect(metadata.value).toEqual([
          {
            id: "thread",
            workingDirectory: "/project",
            parentSessionId: "cold-parent",
            sidecarSessionId: "sidecar",
            title: "Review navigation",
            running: true,
            status: "open",
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        ]);
      // Only lightweight current status is available: any transcript inspection/acquisition fails.
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(DiscussionSessionEnvironment, {
            location: () =>
              Effect.succeed({
                agentDirectory: "/agent",
                sessionDirectory: "/discussions",
                parentSessionDirectory: "/primary",
              }),
            list: (workingDirectory, parentSessionId) => {
              expect([workingDirectory, parentSessionId]).toEqual(["/project", "cold-parent"]);
              return Effect.succeed([record]);
            },
          }),
          Layer.mock(ReviewStorage, {
            changes: () => Stream.succeed(1),
            agentSessionDirectory: () => {
              throw new Error("Metadata must not create Pi sessions");
            },
            reviewContextPath: () => {
              throw new Error("Metadata must not generate transcript context");
            },
            discussionParentContextPath: () => {
              throw new Error("Metadata must not generate transcript context");
            },
          }),
          Layer.mock(CakeSessionRuntimes, {
            currentStatus: () =>
              Effect.succeed({ streaming: true, pending: false, persisted: true }),
          }),
          Layer.mock(SessionCatalogChanges, { initialThenChanges: (initial) => initial }),
        ),
      ),
    );
  },
);

it.effect("does not republish unchanged worker metadata for unrelated coordinator revisions", () =>
  Effect.gen(function* () {
    const coordinator = yield* SubagentCoordinator;
    const record = subagentHistoryFixture();
    const processed = yield* Queue.unbounded<void>();
    const output = yield* Queue.unbounded<readonly { task: string }[]>();
    const stream = yield* subagentObservation.observeMetadata(record.parentSessionId).pipe(
      Effect.provideService(SubagentCoordinator, {
        ...coordinator,
        storage: {
          ...coordinator.storage,
          history: {
            ...coordinator.storage.history,
            list: () =>
              coordinator.storage.history
                .list()
                .pipe(Effect.tap(() => Queue.offer(processed, undefined))),
          },
        },
      }),
    );
    yield* stream.pipe(
      Stream.runForEach((value) => Queue.offer(output, value)),
      Effect.forkScoped,
    );
    expect((yield* Queue.take(output))[0]?.task).toBe(record.task);
    yield* Queue.take(processed);
    for (let revision = 1; revision <= 3; revision += 1) {
      yield* SubscriptionRef.update(coordinator.state, (state) => ({ ...state, revision }));
      yield* Queue.take(processed);
    }
    yield* coordinator.storage.history.update({ ...record, task: "Updated worker task" });
    yield* SubscriptionRef.update(coordinator.state, (state) => ({ ...state, revision: 4 }));
    expect((yield* Queue.take(output))[0]?.task).toBe("Updated worker task");
  }).pipe(
    Effect.provide(
      SubagentCoordinatorLive.pipe(
        Layer.provide(makeSubagentStorageTestLayer([], [subagentHistoryFixture()])),
      ),
    ),
  ),
);

it.effect("does not republish empty discussion metadata for unrelated storage changes", () =>
  Effect.gen(function* () {
    const stream = yield* discussions.observeMetadata({
      workingDirectory: "/project",
      parentSessionId: "owner",
    });
    expect(yield* stream.pipe(Stream.runCollect)).toEqual([[]]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(DiscussionSessionEnvironment, { list: () => Effect.succeed([]) }),
        Layer.mock(ReviewStorage, {
          changes: () => Stream.make(1, 2, 3, 4),
          agentSessionDirectory: () => {
            throw new Error("Metadata must not request session paths");
          },
          reviewContextPath: () => {
            throw new Error("Metadata must not request review context");
          },
          discussionParentContextPath: () => {
            throw new Error("Metadata must not request parent context");
          },
        }),
        Layer.mock(CakeSessionRuntimes, {}),
        Layer.mock(SessionCatalogChanges, { initialThenChanges: () => Stream.empty }),
      ),
    ),
  ),
);
