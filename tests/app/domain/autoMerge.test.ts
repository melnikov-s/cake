import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { expect } from "vitest";
import * as digest from "../../../src/domain/cake-chats/cakeChatDigest";
import { snapshot } from "../helpers/piRuntimeFixture";
import { runPass } from "../../../src/domain/worktrees/autoMerge";
import { report, setEnabled } from "../../../src/domain/worktrees/autoMergeReadiness";
import { ManagedWorktreeError } from "../../../src/contracts/worktrees/managed-worktrees-errors";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { WorktreeLandingAgent } from "../../../src/services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../../src/services/worktrees/WorktreeLandingCompletion";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const target = { sessionId: "owner", workingDirectory: "/tree", sessionDirectory: "/sessions" };
const commit = "a".repeat(40);
const readiness = {
  readyToMerge: true,
  taskCompleted: true,
  validationPassed: true,
  validatedCommit: commit,
};
const record = {
  projectPath: "/project",
  worktreePath: "/tree",
  branch: "agent/test",
  baseBranch: "main",
  createdAt: "2026-01-01T00:00:00Z",
  state: "active" as const,
};

function fixture(
  options: {
    conflict?: boolean;
    failure?: boolean;
    resolveFailure?: boolean;
    wait?: Effect.Effect<void>;
    head?: string;
    recovery?: boolean;
  } = {},
) {
  const events: string[] = [];
  let active: string[] = [];
  let currentRecord: WorktreeRecord = options.recovery
    ? { ...record, state: "landed", resolveAfterLanding: true, landedSourceCommit: commit }
    : record;
  const layer = Layer.mergeAll(
    familyStorageHarness().layer,
    WorktreeLandingCoordinatorLive,
    Layer.mock(CakeSessionRuntimes, {
      executingTurnIds: () => Effect.succeed(["turn"]),
      activeWorkingDirectories: () => Effect.sync(() => active),
    }),
    Layer.mock(ApplicationState, { snapshot: () => defaultApplicationState() }),
    Layer.mock(ManagedWorktrees, {
      status: () =>
        Effect.succeed({
          record,
          targetBranch: "main",
          dirtyCount: 0,
          aheadCount: options.recovery ? 0 : 1,
          behindCount: 0,
          merged: false,
          targetDirty: false,
          targetOnBranch: true,
          merging: false,
          rebasing: false,
          squashMessageReady: false,
        }),
      records: () => Effect.sync(() => [currentRecord]),
      prepareLanding: () => Effect.void,
      cancelLanding: () => Effect.void,
      setResolveAfterLanding: (_path, value) =>
        Effect.sync(() => {
          events.push(`intent:${value}`);
        }),
      land: (_path, _id, request, _progress, authorize) =>
        Effect.gen(function* () {
          yield* options.wait ?? Effect.void;
          yield* authorize ?? Effect.void;
          if (
            request.strategy !== "preserve" ||
            request.expectedSourceCommit !== (options.head ?? commit)
          )
            return yield* new ManagedWorktreeError({
              operation: "land",
              message: "Stale validated commit",
            });
          events.push("land");
          if (options.failure)
            return yield* new ManagedWorktreeError({ operation: "land", message: "Target dirty" });
          return options.conflict
            ? { outcome: "resolving" as const, files: ["conflict.ts"] }
            : { outcome: "landed" as const, commit };
        }),
    }),
    Layer.mock(WorktreeLandingAgent, {
      promptAndWait: () => Effect.die("Automatic landing must not ask an LLM for repairs"),
    }),
    Layer.mock(WorktreeLandingCompletion, {
      resolveWorkingDirectory: () =>
        Effect.sync(() => {
          events.push("resolve");
          if (!options.resolveFailure)
            currentRecord = { ...currentRecord, state: "resolved", resolvedFrom: "landed" };
          return {
            projectPath: "/project",
            workingDirectory: "/tree",
            resolvedSessionIds: options.resolveFailure ? [] : ["owner"],
            failures: options.resolveFailure
              ? [{ sessionIds: ["owner"], message: "Session active" }]
              : [],
            cleanupFailures: [],
          };
        }),
    }),
  );
  return {
    layer,
    events,
    setActive: (paths: string[]) => {
      active = paths;
    },
  };
}

it.effect.each([
  { options: {}, merged: true, resolved: true },
  { options: { resolveFailure: true }, merged: true, resolved: false },
  { options: { conflict: true }, merged: false, resolved: false },
  { options: { failure: true }, merged: false, resolved: false },
])(
  "queues one truthful backend outcome reminder after resolution/partial failure: %j",
  (scenario) => {
    const test = fixture(scenario.options);
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.registerSpawn({
        sessionId: "owner",
        projectPath: "/project",
        workingDirectory: "/tree",
        requester: { sessionId: "project-chat:origin", kind: "cake-chat", title: "Project Chat" },
        reportDelivered: true,
        handoffSettled: true,
      });
      yield* ready;
      yield* runPass();
      expect((yield* storage.state()).coordinatorDigest ?? []).toEqual([]);
      yield* terminal;
      yield* runPass();
      yield* runPass();
      const state = yield* storage.state();
      expect(state.coordinatorDigest).toHaveLength(1);
      expect(state.coordinatorDigest?.[0]?.userInputOnly).toBe(true);
      expect(state.coordinatorDigest?.[0]?.summary).toContain(
        `merged=${scenario.merged}; resolutionSucceeded=${scenario.resolved}; targetBranch=main`,
      );
      expect(state.coordinatorDigest?.[0]?.summary).toContain(
        `landedCommit=${scenario.merged ? commit : "none"}`,
      );
      // This outbox is independent of the now-resolved source and schedules no new wake.
      expect((yield* storage.state()).updateBatches ?? []).toEqual([]);
      const handle = {
        snapshot: () => Effect.succeed({ ...snapshot, sessionId: "project-chat:origin" }),
      };
      const prepared = yield* digest.prepareUserMessage(handle, "My next question");
      expect(prepared.text).toContain("<system-reminder>");
      expect(prepared.text).toContain("cake://session/owner");
      expect(prepared.text).toContain("targetBranch=main");
      expect(prepared.text).toContain(`resolutionSucceeded=${scenario.resolved}`);
      expect(prepared.digestIds).toEqual(["auto-merge:turn"]);
      yield* storage.removeDigest(prepared.digestIds);
      yield* runPass();
      expect((yield* storage.state()).coordinatorDigest).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

const requests = Effect.flatMap(SessionFamilyStorage, (storage) =>
  storage.state().pipe(Effect.map((state) => state.autoMergeRequests ?? [])),
);
const ready = Effect.gen(function* () {
  yield* setEnabled(true);
  expect(yield* report(target, readiness)).toEqual({ eligible: true });
  yield* (yield* SessionFamilyStorage).updateAutoMerge("turn", "ready");
});
const terminal = Effect.gen(function* () {
  const coordinator = yield* WorktreeLandingCoordinator;
  yield* SubscriptionRef.changes(coordinator.state).pipe(
    Stream.filter((state) =>
      ["landed", "failed", "stalled"].includes(state.operations.get("/tree")?.phase ?? ""),
    ),
    Stream.runHead,
  );
});

it.effect(
  "default off never lands; enabling an incomplete declaration still waits for task settlement",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      expect(yield* report(target, readiness)).toEqual({ eligible: false });
      yield* setEnabled(true);
      yield* runPass();
      expect(test.events).toEqual([]);
      expect((yield* requests)[0]?.state).toBe("pending");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "retains completed structured readiness while off and projects it independently of unread completions",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* report(target, readiness);
      yield* storage.updateAutoMerge("turn", "ready");
      yield* runPass();
      expect(test.events).toEqual([]);
      expect((yield* requests)[0]).toMatchObject({ readyToMerge: true, state: "ready" });
      const projection = yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
      expect(projection.autoMergeRequests?.[0]?.state).toBe("ready");
      expect((yield* storage.state()).completionInbox ?? []).toEqual([]);
      yield* report(target, { ...readiness, readyToMerge: false });
      expect((yield* requests)[0]).toMatchObject({ readyToMerge: false, state: "canceled" });
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "enabling adopts valid structured ready work declared while off, but not generic history",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* report(target, readiness);
      yield* (yield* SessionFamilyStorage).updateAutoMerge("turn", "ready");
      yield* runPass();
      expect(test.events).toEqual([]);
      yield* setEnabled(true);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]?.state).toBe("landed");
      expect(test.events).toContain("resolve");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "failed valid ready work can be retried by a later opt-in, with one outcome per attempt",
  () => {
    const options = { failure: true };
    const test = fixture(options);
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.registerSpawn({
        sessionId: "owner",
        projectPath: "/project",
        workingDirectory: "/tree",
        requester: { sessionId: "project-chat:origin", kind: "cake-chat", title: "Project Chat" },
        reportDelivered: true,
        handoffSettled: true,
      });
      yield* ready;
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: true });
      yield* setEnabled(false);
      options.failure = false;
      yield* setEnabled(true);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]).toMatchObject({ state: "landed", attempt: 1 });
      expect(test.events.filter((item) => item === "land")).toHaveLength(2);
      expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
      expect((yield* storage.state()).coordinatorDigest?.map((item) => item.id)).toEqual([
        "auto-merge:turn",
        "auto-merge:turn:1",
      ]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "retries its own stalled automatic operation without misclassifying it as a manual landing",
  () => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      yield* runPass();
      yield* terminal;
      yield* runPass();
      yield* setEnabled(false);
      yield* setEnabled(true);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]?.message).toContain("conflict resolution");
      expect((yield* requests)[0]?.message).not.toContain("manual landing");
      expect(test.events.filter((item) => item === "land")).toHaveLength(2);
      expect(test.events).not.toContain("resolve");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["taskCompleted", "validationPassed"] as const)(
  "rejects readiness without %s",
  (field) => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* setEnabled(true);
      expect(
        (yield* report(target, { ...readiness, [field]: false }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* runPass();
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "accepts proportionate task validation without repo-wide green gates; waits for settlement, merges/resolves once and deduplicates replay",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* setEnabled(true);
      yield* report(target, readiness);
      yield* runPass();
      expect(test.events).toEqual([]);
      yield* (yield* SessionFamilyStorage).updateAutoMerge("turn", "ready");
      yield* runPass();
      yield* terminal;
      yield* runPass();
      yield* report(target, readiness);
      yield* runPass();
      expect(test.events).toEqual(["land", "intent:true", "resolve", "intent:false"]);
      expect((yield* requests)[0]?.state).toBe("landed");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["off", "new-input", "re-enabled"] as const)(
  "rechecks %s after queue wait, before Git or resolution",
  (change) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const test = fixture({ wait: Deferred.await(gate) });
      yield* Effect.gen(function* () {
        yield* ready;
        yield* runPass();
        if (change === "new-input")
          yield* (yield* SessionFamilyStorage).invalidateAutoMerge("/tree");
        else {
          yield* setEnabled(false);
          if (change === "re-enabled") yield* setEnabled(true);
        }
        yield* Deferred.succeed(gate, undefined);
        yield* terminal;
        yield* runPass();
        expect(test.events).not.toContain("land");
        expect(test.events).not.toContain("resolve");
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect.each([
  { conflict: true },
  { failure: true },
  { head: "b".repeat(40) },
  { resolveFailure: true },
])("keeps failed/blocked landing unresolved: %j", (options) => {
  const test = fixture(options);
  return Effect.gen(function* () {
    yield* ready;
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: true });
    if (!options.resolveFailure) expect(test.events).not.toContain("resolve");
    yield* runPass();
    expect(test.events.filter((event) => event === "land").length).toBeLessThanOrEqual(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "invalidates persisted ready work on restart and never replays uncertain landing attempts",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      for (const state of ["ready", "landing"] as const) {
        yield* storage.recordAutoMerge({
          readyToMerge: true,
          id: state,
          sessionId: "owner",
          workspacePath: "/tree",
          epoch: "previous-process",
          runId: "previous-process",
          commit,
          state,
        });
      }
      yield* runPass();
      expect(test.events).toEqual([]);
      expect((yield* requests).map((item) => item.state)).toEqual(["canceled", "failed"]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "recovers only resolution from durable confirmed landing intent, without replaying Git",
  () => {
    const test = fixture({ recovery: true });
    return Effect.gen(function* () {
      yield* (yield* SessionFamilyStorage).recordAutoMerge({
        readyToMerge: true,
        id: "interrupted",
        sessionId: "owner",
        workspacePath: "/tree",
        epoch: "previous-process",
        runId: "previous-process",
        commit,
        state: "landing",
      });
      yield* runPass();
      yield* runPass();
      expect(test.events.filter((event) => event === "resolve")).toHaveLength(1);
      expect(test.events).not.toContain("land");
      expect((yield* requests)[0]?.state).toBe("landed");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "generic reports and pending task validation never become readiness; ordinary completion is retained",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* setEnabled(true);
      const storage = yield* SessionFamilyStorage;
      yield* storage.recordTurn({
        sessionId: "owner",
        senderSessionId: "requester",
        turnId: "turn",
        requestMessageId: "request",
        threadId: "thread",
        reported: false,
      });
      yield* storage.recordReport("turn", {
        outcome: "completed",
        resultKind: "ready",
        text: "Finished implementing the requested work; validation pending.",
      });
      yield* storage.settleTurn("turn", "complete");
      yield* runPass();
      expect(test.events).toEqual([]);
      expect(yield* requests).toEqual([]);
      expect((yield* storage.state()).turns[0]?.report?.text).toContain("validation pending");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("serializes concurrent ready sessions without stealing a running operation", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const test = fixture({ wait: Deferred.await(gate) });
    yield* Effect.gen(function* () {
      yield* ready;
      const storage = yield* SessionFamilyStorage;
      const first = (yield* requests)[0];
      expect(first).toBeDefined();
      if (!first) return;
      yield* storage.recordAutoMerge({
        ...first,
        id: "second",
        sessionId: "second",
        workspacePath: "/second",
      });
      yield* runPass();
      yield* runPass();
      expect((yield* requests).map((item) => item.state)).toEqual(["landing", "ready"]);
      yield* Deferred.succeed(gate, undefined);
      yield* terminal;
    }).pipe(Effect.provide(test.layer));
  }),
);
