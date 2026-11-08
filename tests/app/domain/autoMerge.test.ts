import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { expect } from "vitest";
import * as digest from "../../../src/domain/cake-chats/cakeChatDigest";
import { snapshot } from "../helpers/piRuntimeFixture";
import { runPass } from "../../../src/domain/worktrees/autoMerge";
import { report, setEnabled } from "../../../src/domain/worktrees/autoMergeReadiness";
import { ManagedWorktreeError } from "../../../src/contracts/worktrees/managed-worktrees-errors";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
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
import { DOCUMENT_VERSION } from "../../../src/services/storage/sessionFamilyDocumentCodec";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { retainNotification } from "../../../src/domain/session-families/sessionFamilyCompletion";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";

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
    executingTurns?: string[];
    extraRecords?: WorktreeRecord[];
    requester?: string | null;
    landing?: "merge" | "pull-request";
    externalSecond?: boolean;
  } = {},
) {
  const events: string[] = [];
  let landing = options.landing ?? "merge";
  const externalRecord = { ...record, projectPath: "/external", worktreePath: "/external-tree" };
  let active: string[] = [];
  let currentRecord: WorktreeRecord = options.recovery
    ? { ...record, state: "landed", resolveAfterLanding: true, landedSourceCommit: commit }
    : record;
  const layer = Layer.mergeAll(
    familyStorageHarness(
      new Map([
        [
          "state/session-families.json",
          JSON.stringify({
            version: DOCUMENT_VERSION,
            data: {
              families: [],
              turns: [],
              spawnedSessions:
                options.requester === null
                  ? []
                  : [
                      {
                        sessionId: "owner",
                        projectPath: "/project",
                        workingDirectory: "/tree",
                        requester: {
                          sessionId: options.requester ?? projectChatSessionId("/project"),
                          kind: "cake-chat",
                          title: "Project Chat",
                        },
                        reportDelivered: true,
                        handoffSettled: true,
                      },
                    ],
            },
          }),
        ],
      ]),
    ).layer,
    WorktreeLandingCoordinatorLive,
    Layer.mock(SessionCatalogChanges, { publish: () => Effect.void }),
    Layer.mock(CakeSessionRuntimes, {
      executingTurnIds: () => Effect.succeed(options.executingTurns ?? ["turn"]),
      activeWorkingDirectories: () => Effect.sync(() => active),
    }),
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        projects: ["/project", "/other", "/external"].map((path) => ({
          path,
          name: path,
          addedAt: record.createdAt,
          lastOpenedAt: record.createdAt,
          settings: {
            ...defaultProjectSettings(),
            worktreeLanding:
              path === "/external"
                ? ("pull-request" as const)
                : path === "/project"
                  ? landing
                  : ("merge" as const),
          },
        })),
      }),
    }),
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
      records: () =>
        Effect.sync(() => [
          currentRecord,
          ...(options.extraRecords ?? []),
          ...(options.externalSecond ? [externalRecord] : []),
        ]),
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
    setLanding: (value: "merge" | "pull-request") => {
      landing = value;
    },
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
        requester: {
          sessionId: projectChatSessionId("/project"),
          kind: "cake-chat",
          title: "Project Chat",
        },
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
        snapshot: () =>
          Effect.succeed({ ...snapshot, sessionId: projectChatSessionId("/project") }),
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

it.effect("external projects reject readiness even when project auto-merge is enabled", () => {
  const test = fixture({ landing: "pull-request" });
  return Effect.gen(function* () {
    yield* setEnabled("/project", true);
    const result = yield* report(target, readiness).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WorktreeLandingError",
        message: expect.stringContaining("merges outside Cake"),
      },
    });
    expect(yield* requests).toEqual([]);
    expect(
      (yield* SubscriptionRef.get(
        (yield* WorktreeLandingCoordinator).state,
      )).autoMergeProjects?.find((project) => project.projectPath === "/project")?.enabled,
    ).toBe(true);
    expect(test.events).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "a live external transition cancels prior readiness without switching project auto-merge off",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* ready;
      test.setLanding("pull-request");
      yield* runPass();
      expect((yield* requests)[0]?.state).toBe("canceled");
      expect(test.events).toEqual([]);
      expect(
        (yield* SubscriptionRef.get(
          (yield* WorktreeLandingCoordinator).state,
        )).autoMergeProjects?.find((project) => project.projectPath === "/project")?.enabled,
      ).toBe(true);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("mixed projects skip external readiness and still auto-merge the direct project", () => {
  const test = fixture({ externalSecond: true });
  return Effect.gen(function* () {
    yield* ready;
    const storage = yield* SessionFamilyStorage;
    const direct = (yield* requests)[0];
    if (!direct) return yield* Effect.die("Missing direct readiness");
    yield* storage.recordAutoMerge({
      ...direct,
      id: "external-turn",
      sessionId: "external-owner",
      workspacePath: "/external-tree",
      projectPath: "/external",
      state: "pending",
    });
    yield* storage.updateAutoMerge("external-turn", "ready");
    // Direct work remains eligible regardless of the other project’s policy.
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect((yield* requests).find((item) => item.id === "external-turn")?.state).toBe("canceled");
    expect((yield* requests).find((item) => item.id === "turn")?.state).toBe("landed");
    expect(test.events.filter((event) => event === "land")).toHaveLength(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("queued automatic execution rechecks the project policy before Git", () => {
  return Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const test = fixture({
      wait: Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });
    yield* Effect.gen(function* () {
      yield* ready;
      yield* runPass();
      yield* Deferred.await(admitted);
      test.setLanding("pull-request");
      yield* Deferred.succeed(release, undefined);
      yield* terminal;
      yield* runPass();
      expect(test.events).not.toContain("land");
      expect(test.events).not.toContain("resolve");
      expect((yield* requests)[0]?.state).toBe("failed");
    }).pipe(Effect.provide(test.layer));
  });
});

const requests = Effect.flatMap(SessionFamilyStorage, (storage) =>
  storage.state().pipe(Effect.map((state) => state.autoMergeRequests ?? [])),
);
const ready = Effect.gen(function* () {
  yield* setEnabled("/project", true);
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
  "default off accepts readiness without landing; enabling still waits for task settlement",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* runPass();
      expect(test.events).toEqual([]);
      yield* setEnabled("/project", true);
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
      expect(projection.autoMergeRequests?.[0]?.message).toBeUndefined();
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      expect((yield* storage.state()).completionInbox ?? []).toEqual([]);
      expect(yield* report(target, { ...readiness, readyToMerge: false })).toEqual({
        eligible: false,
        reason: "Merge readiness was revoked.",
      });
      expect((yield* requests)[0]).toMatchObject({ readyToMerge: false, state: "canceled" });
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "enabling adopts valid structured ready work declared while off, but not generic history",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* report(target, readiness);
      yield* storage.updateAutoMerge("turn", "ready");
      const first = (yield* requests)[0];
      expect(first).toBeDefined();
      if (!first) return;
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* storage.recordAutoMerge({
        ...first,
        id: "old-run",
        workspacePath: "/old",
        runId: "previous-run",
      });
      yield* storage.recordAutoMerge({
        ...first,
        id: "invalidated",
        workspacePath: "/changed",
      });
      yield* storage.invalidateAutoMerge("/changed");
      yield* runPass();
      expect(test.events).toEqual([]);
      yield* Effect.all([setEnabled("/project", true), setEnabled("/project", true)], {
        concurrency: "unbounded",
      });
      const epoch = (yield* SubscriptionRef.get(
        (yield* WorktreeLandingCoordinator).state,
      )).autoMergeProjects?.find((item) => item.projectPath === "/project")?.epoch;
      yield* setEnabled("/project", true);
      expect(
        (yield* SubscriptionRef.get(
          (yield* WorktreeLandingCoordinator).state,
        )).autoMergeProjects?.find((item) => item.projectPath === "/project")?.epoch,
      ).toBe(epoch);
      yield* runPass();
      yield* runPass();
      yield* terminal;
      yield* runPass();
      yield* runPass();
      expect(
        (yield* requests).map(({ id, state, readyToMerge }) => ({ id, state, readyToMerge })),
      ).toEqual([
        { id: "turn", state: "landed", readyToMerge: true },
        { id: "old-run", state: "canceled", readyToMerge: false },
        { id: "invalidated", state: "canceled", readyToMerge: false },
      ]);
      expect(test.events).toEqual(["land", "intent:true", "resolve", "intent:false"]);
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
        requester: {
          sessionId: projectChatSessionId("/project"),
          kind: "cake-chat",
          title: "Project Chat",
        },
        reportDelivered: true,
        handoffSettled: true,
      });
      yield* ready;
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: true });
      yield* setEnabled("/project", false);
      options.failure = false;
      yield* setEnabled("/project", true);
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
      yield* setEnabled("/project", false);
      yield* setEnabled("/project", true);
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

it.effect.each([{ executingTurns: [] }])(
  "rejects readiness without an executing run and includes diagnostic IDs: %j",
  ({ executingTurns }) => {
    const test = fixture({ executingTurns });
    return Effect.gen(function* () {
      const result = yield* report(target, readiness).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          message:
            "Readiness requires an executing task run for session owner; executing input count=0, ids=[].",
        },
      });
      expect(yield* requests).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["revoked", "previous-run", "different-commit"] as const)(
  "explains ineligible %s readiness without replacing the stored declaration",
  (change) => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* report(target, readiness);
      if (change === "revoked") yield* (yield* SessionFamilyStorage).invalidateAutoMerge("/tree");
      if (change === "previous-run")
        yield* SubscriptionRef.update((yield* WorktreeLandingCoordinator).state, (state) => ({
          ...state,
          autoMergeRunId: "new-run",
        }));
      const result = yield* report(
        target,
        change === "different-commit"
          ? { ...readiness, validatedCommit: "b".repeat(40) }
          : readiness,
      );
      expect(result).toEqual({
        eligible: false,
        reason:
          change === "revoked"
            ? "New input invalidated merge readiness"
            : change === "previous-run"
              ? "Readiness belongs to a previous app run."
              : "Stored readiness does not match this session, workspace, or validated commit.",
      });
      expect((yield* requests)[0]?.commit).toBe(commit);
      yield* setEnabled("/project", true);
      yield* runPass();
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["landing", "landed", "failed", "canceled"] as const)(
  "explains already %s declarations instead of silently returning false",
  (state) => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* report(target, readiness);
      yield* (yield* SessionFamilyStorage).updateAutoMerge(
        "turn",
        state,
        "Existing landing outcome",
      );
      expect(yield* report(target, readiness)).toEqual({
        eligible: false,
        reason: "Existing landing outcome",
      });
      expect((yield* requests)[0]?.state).toBe(state);
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["taskCompleted", "validationPassed"] as const)(
  "rejects readiness without %s",
  (field) => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* setEnabled("/project", true);
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
      yield* setEnabled("/project", true);
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
          yield* setEnabled("/project", false);
          if (change === "re-enabled") yield* setEnabled("/project", true);
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
    if (options.head) expect((yield* requests)[0]?.message).toContain("Stale validated commit");
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
      yield* setEnabled("/project", true);
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

it.effect(
  "off → structured readiness → exact quiet handoff → enable → serialized landing and resolution",
  () => {
    const test = fixture({ requester: null });
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const source = "cake://session/owner?message=original-result";
      const turn = {
        sessionId: "owner",
        senderSessionId: projectChatSessionId("/project"),
        turnId: "turn",
        requestMessageId: "owner",
        threadId: "thread",
        reported: false,
        resultDelivery: "notification" as const,
      };
      yield* storage.registerSpawn({
        sessionId: "owner",
        projectPath: "/project",
        workingDirectory: "/tree",
        requester: { sessionId: turn.senderSessionId, kind: "cake-chat", title: "Project Chat" },
        reportDelivered: false,
        handoffSettled: false,
      });
      yield* storage.recordTurn(turn);
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* storage.updateAutoMerge("turn", "ready");
      const reportBody = {
        outcome: "completed" as const,
        text: "Implemented and validated the complete requested repair.",
        resultMessageRef: source,
      };
      yield* storage.settleTurn("turn", "complete", reportBody);
      yield* runPass();
      expect((yield* requests)[0]?.message).toBe("Waiting for result handoff");
      const settled = (yield* storage.state()).turns[0];
      expect(settled).toBeDefined();
      if (!settled) return;
      yield* retainNotification(settled, (yield* storage.state()).spawnedSessions[0]);
      yield* runPass();
      expect(test.events).toEqual([]);
      expect((yield* requests)[0]?.message).toBe("Auto-merge is off; ready for manual landing");
      expect((yield* storage.state()).completionInbox?.[0]?.resultMessageRef).toBe(source);
      yield* setEnabled("/project", true);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.events).toEqual(["land", "intent:true", "resolve", "intent:false"]);
      expect((yield* requests)[0]?.state).toBe("landed");
      expect((yield* storage.state()).completionInbox?.[0]?.resultMessageRef).toBe(source);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("rejects foreign executing-input ownership with explicit IDs", () => {
  const test = fixture({ executingTurns: ["turn", "foreign"] });
  return Effect.gen(function* () {
    const storage = yield* SessionFamilyStorage;
    yield* storage.recordTurn({
      sessionId: "another-session",
      senderSessionId: "requester",
      turnId: "foreign",
      requestMessageId: "foreign",
      threadId: "foreign",
      reported: false,
    });
    const result = yield* report(target, readiness).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        message:
          'Executing inputs do not belong to session owner; count=2, ids=["turn","foreign"], foreign ids=["foreign"].',
      },
    });
    expect(yield* requests).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("legacy readiness without canonical project ownership is never adopted", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const storage = yield* SessionFamilyStorage;
    yield* report(target, readiness);
    const first = (yield* requests)[0];
    if (!first) throw new Error("Expected readiness");
    yield* storage.recordAutoMerge({
      id: "legacy",
      sessionId: "owner",
      workspacePath: "/tree",
      epoch: "old-global-authorization",
      runId: first.runId,
      commit,
      readyToMerge: true,
      state: "ready",
    });
    yield* setEnabled("/project", true);
    expect((yield* requests).find((item) => item.id === "legacy")?.epoch).toBe(
      "old-global-authorization",
    );
    yield* runPass();
    expect((yield* requests).find((item) => item.id === "legacy")).toMatchObject({
      state: "canceled",
      message: "Owning project is unavailable; fresh readiness required",
    });
    expect(test.events).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("correlates readiness with a consumed task plus steering and coordination inputs", () => {
  const test = fixture({ executingTurns: ["task", "steer", "coordination"] });
  return Effect.gen(function* () {
    const storage = yield* SessionFamilyStorage;
    for (const id of ["task", "steer", "coordination"])
      yield* storage.recordTurn({
        sessionId: "owner",
        senderSessionId: projectChatSessionId("/project"),
        turnId: id,
        requestMessageId: id,
        threadId: id,
        reported: false,
      });
    expect(yield* report(target, readiness)).toEqual({ eligible: true });
    expect((yield* requests)[0]).toMatchObject({
      id: "task",
      projectPath: "/project",
      state: "pending",
    });
  }).pipe(Effect.provide(test.layer));
});

it.effect.each([
  { requester: null, origin: "human/unknown" },
  { requester: "ca4ec4a7-0000-4000-8000-000000000001", origin: "global chat" },
  { requester: projectChatSessionId("/other"), origin: "another project's chat" },
  { requester: "ordinary-session", origin: "nested delegation" },
])(
  "retains manual readiness without authorizing automatic landing from $origin",
  ({ requester }) => {
    const test = fixture({ requester });
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* storage.updateAutoMerge("turn", "ready");
      // A later request from the right chat never rewrites creation provenance.
      yield* storage.recordTurn({
        sessionId: "owner",
        senderSessionId: projectChatSessionId("/project"),
        turnId: "followup",
        requestMessageId: "followup",
        threadId: "followup",
        reported: false,
        outcome: "complete",
      });
      yield* storage.completeNotice("followup");
      yield* setEnabled("/project", true);
      expect((yield* requests)[0]?.epoch).toBe("");
      yield* runPass();
      expect(test.events).toEqual([]);
      expect((yield* requests)[0]).toMatchObject({ readyToMerge: true, state: "ready" });
      expect((yield* requests)[0]?.message).toContain("Manual landing only");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "authorizes only the selected registered project and rejects global/worktree scope",
  () => {
    const executingTurns = ["turn"];
    const test = fixture({
      executingTurns,
      extraRecords: [{ ...record, projectPath: "/other", worktreePath: "/other-tree" }],
    });
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* report(target, readiness);
      yield* storage.updateAutoMerge("turn", "ready");
      executingTurns.splice(0, 1, "other-turn");
      yield* storage.registerSpawn({
        sessionId: "other-owner",
        projectPath: "/other",
        workingDirectory: "/other-tree",
        requester: {
          sessionId: projectChatSessionId("/other"),
          kind: "cake-chat",
          title: "Other Project Chat",
        },
        reportDelivered: true,
        handoffSettled: true,
      });
      expect(
        yield* report(
          { ...target, sessionId: "other-owner", workingDirectory: "/other-tree" },
          readiness,
        ),
      ).toEqual({ eligible: true });
      yield* storage.updateAutoMerge("other-turn", "ready");
      yield* setEnabled("/project", true);
      expect((yield* requests).find((item) => item.id === "other-turn")?.epoch).toBe("");
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests).find((item) => item.id === "other-turn")).toMatchObject({
        state: "ready",
        message: "Auto-merge is off; ready for manual landing",
      });
      expect(test.events.filter((event) => event === "land")).toHaveLength(1);
      for (const path of ["", "/tree", "cake-chat", "/unknown"])
        expect((yield* setEnabled(path, true).pipe(Effect.result))._tag).toBe("Failure");
      yield* setEnabled("/project", false);
      yield* runPass();
      expect(
        (yield* SubscriptionRef.get(
          (yield* WorktreeLandingCoordinator).state,
        )).autoMergeProjects?.find((item) => item.projectPath === "/other"),
      ).toBeUndefined();
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("serializes concurrent ready sessions without stealing a running operation", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const test = fixture({
      wait: Deferred.await(gate),
      extraRecords: [{ ...record, worktreePath: "/second" }],
    });
    yield* Effect.gen(function* () {
      yield* ready;
      const storage = yield* SessionFamilyStorage;
      const first = (yield* requests)[0];
      expect(first).toBeDefined();
      if (!first) return;
      yield* storage.registerSpawn({
        sessionId: "second",
        projectPath: "/project",
        workingDirectory: "/second",
        requester: {
          sessionId: projectChatSessionId("/project"),
          kind: "cake-chat",
          title: "Project Chat",
        },
        reportDelivered: true,
        handoffSettled: true,
      });
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
