import { sessionNotificationEntries } from "../../../src/contracts/cake-chats/session-digest-reminder";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FiberMap, Layer, Option, Stream, SubscriptionRef } from "effect";
import { expect, vi } from "vitest";
import { ActivityHistory } from "../../../src/services/storage/ActivityHistory";
import { TestClock } from "effect/testing";
import * as reviews from "../../../src/domain/worktrees/delegatedCompletionReviews";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import * as attention from "../../../src/domain/projects/projectTodoAttention";
import { classifyProjectTodos } from "../../../src/renderer/lib/classify-project-todos";
import { applySnapshot, effect as reactiveEffect } from "r-state-tree";
import { createRendererStoreFixture } from "../renderer/renderer-store-fixture";
import { projectRecord, sessionSummary } from "../renderer/fixtures/catalog-fixtures";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import type { WorktreeLandingOperation } from "../../../src/contracts/worktrees/worktree-landing-data";
import * as digest from "../../../src/domain/cake-chats/cakeChatDigest";
import { snapshot } from "../helpers/piRuntimeFixture";
import { runPass } from "../../../src/domain/worktrees/autoMerge";
import { setPurpose } from "../../../src/domain/project-sessions/projectSessionOperations";
import * as projects from "../../../src/domain/projects/projects";
import { ArtifactGarbageCollector } from "../../../src/services/artifacts/ArtifactGarbageCollector";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import { ClientWorkspacesLive } from "../../../src/services/clients/ClientWorkspacesLive";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { makeTurnLifecycle } from "../../../src/domain/project-sessions/projectSessionTurnLifecycle";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import {
  cancel,
  acknowledge,
  start,
  inspect,
  retry,
  mergeAndResolve,
  observeOperations,
} from "../../../src/domain/worktrees/worktreeLandings";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import { initialize, report, setEnabled } from "../../../src/domain/worktrees/autoMergeReadiness";
import { ManagedWorktreeError } from "../../../src/contracts/worktrees/managed-worktrees-errors";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { SessionFamilyStorageError } from "../../../src/contracts/storage/session-family-storage-errors";
import {
  WorktreeLandingAgent,
  WorktreeLandingAgentError,
} from "../../../src/services/worktrees/WorktreeLandingAgent";
import { makeWorktreeLandingQueue } from "../../../src/services/worktrees/WorktreeLandingQueue";
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
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { fakeApplicationState } from "../../helpers/fakes/applicationState";
import { fakeCakeSessionRuntimes } from "../../helpers/fakes/cakeSessionRuntimes";
import { fakeClientEvents } from "../../helpers/fakes/clientEvents";
import { fakeManagedWorktrees } from "../../helpers/fakes/managedWorktrees";
import { fakeRendererRequestCoordinator } from "../../helpers/fakes/rendererRequestCoordinator";
import { fakeSessionArchiveStorage } from "../../helpers/fakes/sessionArchiveStorage";

const target = { sessionId: "owner", workingDirectory: "/tree", sessionDirectory: "/sessions" };
/** What the repair turn's runtime settled with; void means a successful turn. */
type RepairOutcome = "complete" | "failed" | "aborted" | "unknown" | void;
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
    /** Emulate a successful engine rebase, not a conflict or an agent-created commit. */
    cleanRebaseHead?: string;
    repairFingerprint?: string;
    failure?: boolean;
    resolveFailure?: boolean;
    wait?: Effect.Effect<void>;
    head?: string;
    recovery?: WorktreeRecord;
    recordsWait?: () => Effect.Effect<void>;
    executingTurns?: string[];
    extraRecords?: WorktreeRecord[];
    requester?: string | null;
    landing?: "merge" | "pull-request";
    externalSecond?: boolean;
    savedAutoMerge?: boolean;
    manual?: boolean;
    noRecipient?: boolean;
    onLandedWait?: Effect.Effect<void>;
    afterGitWait?: Effect.Effect<void>;
    cancelWait?: Effect.Effect<void, ManagedWorktreeError>;
    statusWait?: Effect.Effect<void>;
    queue?: Effect.Success<ReturnType<typeof makeWorktreeLandingQueue>>;
    failStorageWrites?: () => boolean;
    /** The owner's User/Delegated purpose; Project Chat launches are delegated. */
    purpose?: "user" | "delegated";
  } = {},
) {
  const events: string[] = [];
  const prompts: string[] = [];
  const notices: Array<{ connectionId: number; event: CakeEvent }> = [];
  const recipients: string[] = [];
  let landing = options.landing ?? "merge";
  const externalRecord = { ...record, projectPath: "/external", worktreePath: "/external-tree" };
  let active: string[] = [];
  let head = options.head ?? commit;
  let conflict: boolean | undefined;
  let executingTurns: string[] | undefined;
  let changedFiles: string[] = [];
  let repair: Effect.Effect<RepairOutcome, WorktreeLandingAgentError> = Effect.void;
  let currentRecord: WorktreeRecord = options.recovery ?? record;
  let application: ReturnType<typeof defaultApplicationState> = {
    ...defaultApplicationState(),
    projects: ["/project", "/other", "/external"].map((path) => ({
      path,
      name: path,
      autoMergeEnabled: options.savedAutoMerge ?? false,
      addedAt: record.createdAt,
      lastOpenedAt: record.createdAt,
      settings: {
        ...defaultProjectSettings(),
        worktreeLanding: path === "/external" ? "pull-request" : "merge",
      },
    })),
  };
  const family = familyStorageHarness(
    new Map([
      [
        "state/session-families.json",
        JSON.stringify({
          version: DOCUMENT_VERSION,
          data: {
            sessionPurposes: ["owner", "other-owner", "second"].map((sessionId) => {
              const purpose =
                sessionId === "owner" ? (options.purpose ?? "delegated") : "delegated";
              return {
                sessionId,
                projectPath:
                  sessionId === "other-owner"
                    ? (options.extraRecords?.find((item) => item.worktreePath === "/other-tree")
                        ?.projectPath ?? "/project")
                    : "/project",
                purpose,
                createdPurpose: purpose,
              };
            }),
            families: [],
            turns: [],
            spawnedSessions:
              options.requester === null
                ? []
                : [
                    {
                      sessionId: "owner",
                      title: "Fix the merge toast",
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
    { failWrites: options.failStorageWrites },
  );
  const queueError = Effect.mapError(
    (error: unknown) =>
      new ManagedWorktreeError({
        operation: "queue",
        message: error instanceof Error ? error.message : String(error),
      }),
  );
  const layer = Layer.mergeAll(
    family.layer,
    WorktreeLandingCoordinatorLive,
    fakeClientEvents({
      broadcast: () => {
        throw new Error("Auto-merge must not broadcast notifications");
      },
      sendTo: (connectionId, event) => {
        notices.push({ connectionId, event });
        return true;
      },
    }),
    fakeRendererRequestCoordinator({
      connectionForSession: (sessionId) =>
        Effect.sync(() => {
          recipients.push(sessionId);
          return options.noRecipient ? undefined : 42;
        }).pipe(Effect.tap(() => options.onLandedWait ?? Effect.void)),
    }),
    Layer.mock(SessionCatalogChanges, { publish: () => Effect.void }),
    Layer.mock(TaskInputStorage, {}),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/cake",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
    ClientWorkspacesLive,
    // Removal here preserves sessions; these deletion-only ports must never be called.
    Layer.mock(ArtifactGarbageCollector, {}),
    Layer.mock(ArtifactStorage, {}),
    Layer.mock(ReviewStorage, {
      agentSessionDirectory: () => {
        throw new Error("Unexpected review directory lookup");
      },
      reviewContextPath: () => {
        throw new Error("Unexpected review context lookup");
      },
      discussionParentContextPath: () => {
        throw new Error("Unexpected discussion context lookup");
      },
    }),
    Layer.mock(SubagentEnvironment, {}),
    SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
    Layer.mock(ProjectAccess, {
      isAllowed: () => Effect.succeed(true),
      allow: () => Effect.void,
      revoke: () => Effect.void,
      forgetWorkingDirectories: () => Effect.void,
    }),
    Layer.mock(ProjectSessionRuntimeHost, { stopWorkingDirectory: () => Effect.void }),
    Layer.mock(Terminal, { closeWorkingDirectory: () => Effect.void }),
    fakeSessionArchiveStorage({ locate: () => Effect.succeed("active") }),
    Layer.mock(SessionCoordination, {
      settleTurn: () => Effect.void,
      checkStorage: () => Effect.void,
    }),
    fakeCakeSessionRuntimes({
      executingTurnIds: () =>
        Effect.sync(() => executingTurns ?? options.executingTurns ?? ["turn"]),
      activeWorkingDirectories: () => Effect.sync(() => active),
    }),
    fakeApplicationState({
      transact: (transition) =>
        Effect.gen(function* () {
          application = yield* transition(application);
          return application;
        }),
      snapshot: () => ({
        ...application,
        projects: application.projects.map((project) =>
          project.path === "/project"
            ? {
                ...project,
                settings: { ...defaultProjectSettings(), worktreeLanding: landing },
              }
            : project,
        ),
      }),
    }),
    fakeManagedWorktrees({
      status: () =>
        Effect.succeed({
          record: currentRecord,
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
        }).pipe(Effect.tap(() => options.statusWait ?? Effect.void)),
      headState: () => Effect.sync(() => ({ head, changedFiles, merging: false, rebasing: false })),
      records: () =>
        Effect.sync(() => [
          currentRecord,
          ...(options.extraRecords ?? []),
          ...(options.externalSecond ? [externalRecord] : []),
        ]).pipe(Effect.tap(() => options.recordsWait?.() ?? Effect.void)),
      observeLandingQueue: () => options.queue?.observe() ?? Stream.succeed([]),
      prepareLanding: (_path, id) =>
        options.queue?.acquireLanding(record, id, undefined, false).pipe(queueError) ?? Effect.void,
      releaseLanding: (_path, id) =>
        options.queue?.cancelLandingInternal(record, id, false).pipe(queueError, Effect.asVoid) ??
        Effect.void,
      cancelLanding: (_path, id, onlyIfQueued = false) =>
        options.queue
          ?.cancelLandingInternal(record, id, onlyIfQueued)
          .pipe(queueError, Effect.asVoid) ??
        options.cancelWait ??
        Effect.void,
      setResolveAfterLanding: (_path, value) =>
        Effect.sync(() => {
          events.push(`intent:${value}`);
          currentRecord = { ...currentRecord, ...(value ? { resolveAfterLanding: true } : null) };
          if (!value) Reflect.deleteProperty(currentRecord, "resolveAfterLanding");
        }),
      land: (_path, id, request, progress, authorize) =>
        Effect.gen(function* () {
          if (options.queue) {
            yield* options.queue.acquireLanding(record, id, progress?.("queued")).pipe(queueError);
            yield* progress?.("landing") ?? Effect.void;
          }
          yield* options.wait ?? Effect.void;
          yield* authorize ?? Effect.void;
          if (
            request.strategy !== "preserve" ||
            (options.manual
              ? request.expectedSourceCommit !== undefined
              : request.expectedSourceCommit !== undefined && request.expectedSourceCommit !== head)
          )
            return yield* new ManagedWorktreeError({
              operation: "land",
              message: "Stale validated commit",
            });
          if (request.expectedSourceCommit)
            currentRecord = { ...currentRecord, pendingAutomaticLanding: true };
          if (options.failure) {
            events.push("pre-git-failure");
            return yield* new ManagedWorktreeError({ operation: "land", message: "Target dirty" });
          }
          events.push("land");
          yield* options.afterGitWait ?? Effect.void;
          if (conflict ?? options.conflict)
            return {
              outcome: "resolving" as const,
              files: ["conflict.ts"],
              repairFingerprint:
                options.repairFingerprint ?? JSON.stringify([head, "target", "conflict-index"]),
            };
          if (options.cleanRebaseHead && head !== options.cleanRebaseHead) {
            head = options.cleanRebaseHead;
            return { outcome: "revalidation-required" as const, commit: head };
          }
          currentRecord = { ...currentRecord, state: "landed", landedSourceCommit: head };
          if (request.automaticSessionId) {
            currentRecord = {
              ...currentRecord,
              automaticLandingReceipt: {
                operationId: id,
                sessionId: request.automaticSessionId,
                commit: head,
              },
            };
            Reflect.deleteProperty(currentRecord, "resolveAfterLanding");
          }
          Reflect.deleteProperty(currentRecord, "pendingAutomaticLanding");
          return { outcome: "landed" as const, commit: head };
        }).pipe(
          Effect.ensuring(
            options.queue
              ? options.queue.cancelLandingInternal(record, id, false).pipe(Effect.orDie)
              : Effect.void,
          ),
        ),
    }),
    Layer.mock(WorktreeLandingAgent, {
      promptAndWait: ({ text }) =>
        Effect.sync(() => {
          events.push(text.includes("Automatic clean-rebase validation") ? "revalidate" : "repair");
          expect(text).toContain("worktrees.reportReadiness");
          expect(text).toContain("Do not call worktrees.merge");
          prompts.push(text);
        }).pipe(
          Effect.andThen(Effect.suspend(() => repair)),
          Effect.map((outcome) =>
            outcome === "unknown" ? undefined : (outcome ?? ("complete" as const)),
          ),
        ),
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
    files: family.files,
    events,
    notices,
    recipients,
    prompts,
    setRepair: (value: Effect.Effect<RepairOutcome, WorktreeLandingAgentError>) => {
      repair = value;
    },
    setChangedFiles: (value: string[]) => {
      changedFiles = value;
    },
    setHead: (value: string) => {
      head = value;
    },
    setConflict: (value: boolean) => {
      conflict = value;
    },
    setExecutingTurns: (value: string[]) => {
      executingTurns = value;
    },
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
    const record = vi.fn<ActivityHistory["Service"]["record"]>();
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.registerSpawn({
        sessionId: "owner",
        title: "Fix the merge toast",
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
      expect((yield* storage.state()).coordinatorDigest ?? []).toEqual([]);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      yield* runPass();
      const state = yield* storage.state();
      expect(test.notices).toEqual(
        scenario.merged
          ? [
              {
                connectionId: 42,
                event: {
                  type: "auto-merge-landed",
                  operationId: "turn",
                  sessionId: "owner",
                  title: "Fix the merge toast",
                },
              },
            ]
          : [],
      );
      expect(test.recipients).toEqual(scenario.merged ? [projectChatSessionId("/project")] : []);
      expect(state.coordinatorDigest).toHaveLength(1);
      expect(state.coordinatorDigest?.[0]?.userInputOnly).toBe(true);
      expect(state.coordinatorDigest?.[0]?.autoMergeOutcome).toMatchObject({
        merged: scenario.merged,
        resolutionSucceeded: scenario.resolved,
        targetBranch: "main",
        ...(scenario.merged ? { landedCommit: commit } : {}),
      });
      expect(state.coordinatorDigest?.[0]?.summary).toBe(
        !scenario.merged
          ? "Merge blocked"
          : scenario.resolved
            ? "Merged and resolved"
            : "Merged · resolution failed",
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
      expect(sessionNotificationEntries(prepared.text)[0]?.autoMergeOutcome).toMatchObject({
        targetBranch: "main",
        resolutionSucceeded: scenario.resolved,
      });
      expect(prepared.digestIds).toEqual(["auto-merge:turn"]);
      yield* storage.removeDigest(prepared.digestIds);
      yield* runPass();
      expect((yield* storage.state()).coordinatorDigest).toEqual([]);
      const events = record.mock.calls.map(([entry]) => entry);
      expect(events.filter((entry) => entry.kind === "merge")).toHaveLength(
        scenario.merged ? 1 : 0,
      );
      expect(events.filter((entry) => entry.kind === "automation")).toMatchObject([
        {
          title: "Auto-merge",
          trigger: "Validated task readiness",
          outcome: "Started",
          sessionId: "owner",
        },
        {
          title: "Auto-merge",
          outcome: scenario.resolved ? "Completed" : "Failed",
          detail: expect.any(String),
        },
      ]);
    }).pipe(
      Effect.provide(test.layer),
      Effect.provideService(ActivityHistory, { record, list: () => Effect.succeed([]) }),
    );
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

it.effect(
  "unchanged auto-merge passes do no renderer projection work and preserve real updates",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const items: ProjectTodo[] = Array.from({ length: 1000 }, (_, index) => ({
        id: `todo-${index}`,
        title: `Task ${index}`,
        description: "",
        status: "",
        revision: 0,
        state: index < 30 ? "open" : "done",
        associations: index === 0 ? [{ kind: "session", sessionId: "owner", title: "Owner" }] : [],
      }));
      using renderer = createRendererStoreFixture({
        projects: [
          { ...projectRecord({ path: "/project" }), todos: { ...emptyProjectTodos(), items } },
        ],
        sessions: [
          sessionSummary({
            sessionId: "owner",
            projectPath: "/project",
            workingDirectory: "/tree",
          }),
        ],
      });
      const chatId = projectChatSessionId("/project");
      applySnapshot(renderer.models.cakeChatCatalog, {
        loaded: true,
        sessions: [{ sessionId: chatId, title: "Project Chat", projectPath: "/project" }],
      });
      const todos = renderer.root.cakeChatCollectionStore.registry.load(chatId).todos;
      expect(todos.value?.items).toHaveLength(1000);
      let classifications = 0;
      const stopClassification = reactiveEffect(() => {
        todos.classifiedItems;
        classifications++;
      });
      using _classification = { [Symbol.dispose]: stopClassification };
      const coordinator = yield* WorktreeLandingCoordinator;
      const operations = new Map<string, WorktreeLandingOperation>(
        Array.from({ length: 40 }, (_, index) => {
          const workspacePath = `/retained-${index}`;
          return [
            workspacePath,
            {
              operationId: `operation-${index}`,
              workspacePath,
              sessionId: `session-${index}`,
              kind: "landing",
              phase: "failed",
              allowDirtyTarget: false,
              queue: {
                blockingOperationId: "blocker",
                position: index + 1,
                queuedAt: 1_767_225_600_000,
              },
            },
          ];
        }),
      );
      yield* SubscriptionRef.update(coordinator.state, (state) => ({ ...state, operations }));
      yield* runPass(); // Synchronize the initial readiness array before counting idle passes.
      const initial = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const changed = yield* Deferred.make<void>();
      let projections = 0;
      let operationSnapshots = 0;
      let reducerMs = 0;
      const observer = yield* (yield* observeOperations()).pipe(
        Stream.runForEach((update) =>
          Effect.gen(function* () {
            const started = performance.now();
            applyWorktreeOperationCatalogUpdate(renderer.models.worktreeOperations, update);
            reducerMs += performance.now() - started;
            projections++;
            operationSnapshots += update.operations.length;
            yield* Deferred.succeed(initial, undefined);
            if (update.autoMergeProjects?.some((project) => project.status === "drained"))
              yield* Deferred.succeed(drained, undefined);
            if (
              update.autoMergeRequests?.some(
                (request) => request.id === "turn" && request.readyToMerge,
              )
            )
              yield* Deferred.succeed(changed, undefined);
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(initial);
      projections = 0;
      operationSnapshots = 0;
      reducerMs = 0;
      const initialClassifications = classifications;
      for (let index = 0; index < 100; index++) yield* runPass();
      // An ordered real state change drains every earlier publication; no sleeps/polling.
      yield* SubscriptionRef.update(coordinator.state, (state) => ({
        ...state,
        autoMergeProjects: [
          { projectPath: "/project", enabled: false, epoch: "test", status: "drained" },
        ],
      }));
      yield* Deferred.await(drained);
      const idle = {
        projections: projections - 1,
        operationSnapshots: operationSnapshots - 40,
        classifications: classifications - initialClassifications,
      };
      console.info("auto-merge idle probe (100 controlled passes, 40 operations, 1000 todos)", {
        ...idle,
        reducerMsIncludingDrain: reducerMs,
      });
      expect(idle).toEqual({ projections: 0, operationSnapshots: 0, classifications: 0 });
      expect(todos.classifiedItems.active).toHaveLength(30);
      expect(todos.classifiedItems.done).toHaveLength(970);
      // New readiness still reaches the to-do classifier through the same stream/reducer.
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* runPass();
      yield* Deferred.await(changed);
      expect(todos.classifiedItems.ready.map((item) => item.id)).toEqual(["todo-0"]);
      // A real to-do edit must not be hidden by suppression of unrelated worker ticks.
      const project = renderer.models.projects.find("/project")!;
      project.todos = {
        ...project.todos,
        items: project.todos.items.map((item) =>
          item.id === "todo-0" ? { ...item, state: "done", revision: 1 } : item,
        ),
      };
      expect(todos.classifiedItems.ready).toEqual([]);
      expect(todos.classifiedItems.done).toHaveLength(971);
      expect(classifications).toBeGreaterThan(initialClassifications);
      yield* Fiber.interrupt(observer);
    }).pipe(Effect.provide(test.layer));
  },
);

const requests = Effect.flatMap(SessionFamilyStorage, (storage) =>
  storage.state().pipe(Effect.map((state) => state.autoMergeRequests ?? [])),
);
const trackOwner = Effect.gen(function* () {
  yield* projectTodos.ensureSession("/project", "owner", "Review changes", "");
  return (yield* projectTodos.list("/project")).items[0]!;
});
const tracked = Effect.gen(function* () {
  return (yield* projectTodos.list("/project")).items[0]!;
});
const taskAnswer = {
  sessionId: "owner",
  turnId: "turn",
  outcome: "complete" as const,
  result: {
    stopReason: "stop" as const,
    entryId: "final",
    respondsToSessionId: projectChatSessionId("/project"),
    text: "Completed the investigation and verified the startup findings.",
  },
};
const launchTurn = {
  sessionId: "owner",
  senderSessionId: projectChatSessionId("/project"),
  turnId: "turn",
  requestMessageId: "owner",
  threadId: "owner",
  reported: false,
  resultDelivery: "notification" as const,
};

it.effect(
  "finishing while off projects into Needs attention, preserving manual readiness and quiet delivery",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* trackOwner;
      yield* (yield* SessionFamilyStorage).recordTurn(launchTurn);
      yield* report(target, readiness);
      test.setActive(["/tree"]);
      yield* reviews.reconcile();
      expect((yield* tracked).needsAttention).toBe(false);
      test.setActive([]);
      yield* (yield* ownerTurnHooks()).onTurnSettled(taskAnswer);
      yield* reviews.reconcile();
      const todo = yield* tracked;
      const [request] = yield* requests;
      expect(request).toMatchObject({ state: "ready", readyToMerge: true });
      const sections = classifyProjectTodos([todo], [], "", () => request?.readyToMerge === true);
      expect(sections.attention).toEqual([todo]);
      expect(sections.ready).toEqual([]);
      expect(todo.attentionReason).toContain("merge manually");
      expect(
        yield* attention.hold(
          {
            id: "fixture-report",
            recipientSessionId: launchTurn.senderSessionId,
            text: "Final findings",
          },
          { sessionId: "owner" },
        ),
      ).toBe(false);
      expect((yield* projectTodos.list("/project")).pending).toEqual([]);
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "eligible auto-merge stays quiet during handoff and landing, then confirms resolution",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* trackOwner;
      const storage = yield* SessionFamilyStorage;
      yield* setEnabled("/project", true);
      yield* storage.recordTurn(launchTurn);
      yield* report(target, readiness);
      yield* (yield* ownerTurnHooks()).onTurnSettled(taskAnswer);
      yield* runPass();
      yield* reviews.reconcile();
      expect((yield* tracked).needsAttention).toBe(false);
      expect(test.events).toEqual([]);
      const settled = (yield* storage.state()).turns[0]!;
      yield* retainNotification(settled);
      yield* runPass();
      yield* reviews.reconcile();
      expect((yield* tracked).needsAttention).toBe(false);
      yield* terminal;
      yield* runPass();
      yield* reviews.reconcile();
      expect((yield* requests)[0]?.outcome).toMatchObject({
        merged: true,
        resolutionSucceeded: true,
        landedCommit: commit,
      });
      expect((yield* tracked).completionReviews).toBeUndefined();
      expect(test.events).toEqual(["land", "intent:true", "resolve", "intent:false"]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each([
  {
    options: { requester: "global-coordinator" },
    reason: "not directly delegated",
    state: "ready",
  },
  { options: { failure: true }, reason: "Target dirty", state: "failed" },
  { options: { resolveFailure: true }, reason: "already merged", state: "failed" },
])(
  "surfaces an actionable decision when landing does not finish: $reason",
  ({ options, reason, state }) => {
    const test = fixture(options);
    return Effect.gen(function* () {
      yield* trackOwner;
      yield* setEnabled("/project", true);
      yield* report(target, readiness);
      yield* (yield* ownerTurnHooks()).onTurnSettled(taskAnswer);
      yield* runPass();
      if (state === "failed") yield* terminal;
      yield* runPass();
      yield* reviews.reconcile();
      expect((yield* requests)[0]?.state).toBe(state);
      expect(yield* tracked).toMatchObject({
        needsAttention: true,
        attentionReason: expect.stringContaining(reason),
      });
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "flags a stalled handoff after the grace period, not during ordinary reply scheduling",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* trackOwner;
      yield* setEnabled("/project", true);
      yield* (yield* SessionFamilyStorage).recordTurn({ ...launchTurn, resultDelivery: "reply" });
      yield* report(target, readiness);
      yield* (yield* ownerTurnHooks()).onTurnSettled(taskAnswer);
      yield* runPass();
      yield* TestClock.adjust("59 seconds");
      yield* reviews.reconcile();
      expect((yield* tracked).needsAttention).toBe(false);
      yield* TestClock.adjust("1 second");
      yield* reviews.reconcile();
      expect((yield* tracked).attentionReason).toContain("waiting for result handoff");
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "a successful non-mergeable assignment remains reviewable after its quiet report is consumed",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* trackOwner;
      yield* setEnabled("/project", true);
      const storage = yield* SessionFamilyStorage;
      yield* storage.recordTurn(launchTurn);
      yield* (yield* ownerTurnHooks()).onTurnSettled(taskAnswer);
      yield* retainNotification((yield* storage.state()).turns[0]!);
      yield* storage.updateCompletion(launchTurn.senderSessionId, launchTurn.turnId, "handled");
      yield* reviews.reconcile();
      expect(yield* requests).toEqual([]);
      expect(yield* tracked).toMatchObject({
        needsAttention: true,
        attentionReason: expect.stringContaining("Review the completed delegated result"),
      });
      expect((yield* storage.state()).completionInbox?.[0]?.state).toBe("handled");
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["follow-up", "aborted", "reported", "superseded", "new input", "FYI"] as const)(
  "does not surface a non-final or stale result (%s)",
  (variant) => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* trackOwner;
      const storage = yield* SessionFamilyStorage;
      if (variant !== "FYI")
        yield* storage.recordTurn({
          ...launchTurn,
          reported: variant === "reported",
          requestMessageId: variant === "follow-up" ? "follow-up" : "owner",
        });
      if (variant === "superseded") yield* report(target, readiness);
      yield* (yield* ownerTurnHooks()).onTurnSettled({
        ...taskAnswer,
        outcome: variant === "aborted" ? "aborted" : "complete",
      });
      if (variant === "superseded" || variant === "new input")
        yield* storage.invalidateAutoMerge("/tree", undefined, undefined, "owner");
      yield* reviews.reconcile();
      expect((yield* tracked).needsAttention).toBe(false);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "backfills outstanding legacy readiness on restart without reviving an acknowledged decision",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* trackOwner;
      const storage = yield* SessionFamilyStorage;
      yield* report(target, readiness);
      yield* storage.updateAutoMerge("turn", "ready");
      const coordinator = yield* WorktreeLandingCoordinator;
      yield* SubscriptionRef.update(coordinator.state, (state) => ({
        ...state,
        autoMergeRunId: "restarted",
      }));
      yield* runPass();
      yield* reviews.reconcile();
      const todo = yield* tracked;
      expect(todo.attentionReason).toContain("authorization expired");
      yield* projectTodos.mutateUser("/project", {
        _tag: "SetAttention",
        id: todo.id,
        expectedRevision: todo.revision,
        needsAttention: false,
      });
      const dismissed = yield* tracked;
      yield* reviews.reconcile();
      expect(yield* tracked).toEqual(dismissed);
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "keeps explicit attention and never revives a dismissed completion after a later attention edit",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* trackOwner;
      const setAttention = Effect.fn(function* (needsAttention: boolean, reason?: string) {
        const item = yield* tracked;
        yield* projectTodos.mutateUser("/project", {
          _tag: "SetAttention",
          id: item.id,
          expectedRevision: item.revision,
          needsAttention,
          ...(reason ? { attentionReason: reason } : null),
        });
      });
      yield* setAttention(true, "Ask the user about scope first");
      yield* report(target, readiness);
      yield* (yield* ownerTurnHooks()).onTurnSettled(taskAnswer);
      yield* reviews.reconcile();
      expect((yield* tracked).attentionReason).toBe("Ask the user about scope first");
      yield* setAttention(false);
      yield* reviews.reconcile();
      expect((yield* tracked).attentionReason).toContain("Auto-merge is off");
      yield* setAttention(false);
      yield* setAttention(true, "Different question");
      yield* setAttention(false);
      const dismissed = yield* tracked;
      yield* reviews.reconcile();
      expect(yield* tracked).toEqual(dismissed);
    }).pipe(Effect.provide(test.layer));
  },
);

const ready = Effect.gen(function* () {
  yield* setEnabled("/project", true);
  expect(yield* report(target, readiness)).toEqual({ eligible: true });
  yield* (yield* SessionFamilyStorage).updateAutoMerge("turn", "ready");
});
const ownerTurnHooks = () =>
  makeTurnLifecycle({
    sessionId: "owner",
    location: {
      projectPath: "/project",
      projectName: "Project",
      workingDirectory: "/tree",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    },
  });
const settleOwnerTurn = (turnId: string) =>
  Effect.gen(function* () {
    const hooks = yield* ownerTurnHooks();
    yield* hooks.onTurnSettled({
      sessionId: "owner",
      turnId,
      outcome: "complete",
      result: {
        stopReason: "stop",
        text: "Implemented the fix and passed the focused validation suite.",
      },
    });
  });
const admitNewInput = Effect.gen(function* () {
  const hooks = yield* ownerTurnHooks();
  yield* hooks.admitTurn(
    { turnId: "next-input", text: "Investigate the next task", delivery: "prompt" },
    Effect.void,
  );
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
  "removing and registering the same project retires an admitted attempt and defaults off",
  () =>
    Effect.gen(function* () {
      const queue = yield* makeWorktreeLandingQueue(() => Effect.succeed("/repo"));
      const blocker = { ...record, worktreePath: "/blocker" };
      yield* queue.acquireLanding(blocker, "blocker");
      const test = fixture({ queue });
      yield* Effect.gen(function* () {
        yield* ready;
        yield* runPass();
        const coordinator = yield* WorktreeLandingCoordinator;
        yield* SubscriptionRef.changes(coordinator.state).pipe(
          Stream.filter((s) => s.operations.get("/tree")?.phase === "queued"),
          Stream.runHead,
        );
        yield* projects.remove(7, { path: "/project", deleteSessions: false });
        const { state } = yield* projects.register(7, { path: "/project", name: "Re-registered" });
        expect(state.projects.find((p) => p.path === "/project")?.autoMergeEnabled).toBeUndefined();
        const projectsAfter = (yield* SubscriptionRef.get(coordinator.state)).autoMergeProjects;
        expect(projectsAfter?.find((p) => p.projectPath === "/project")?.enabled ?? false).toBe(
          false,
        );

        test.setExecutingTurns(["fresh"]);
        expect(yield* report(target, readiness)).toEqual({ eligible: true });
        yield* settleOwnerTurn("fresh");
        yield* runPass();
        expect((yield* requests).find((r) => r.id === "fresh")?.message).toContain(
          "Auto-merge is off",
        );
        expect(test.events).toEqual([]);

        yield* setEnabled("/project", true);
        yield* queue.cancelLandingInternal(blocker, "blocker", false);
        yield* terminal;
        expect(test.events).toEqual([]);
        expect((yield* requests).find((r) => r.id === "turn")).toMatchObject({
          state: "canceled",
          readyToMerge: false,
          message: expect.stringContaining("removed"),
        });
        yield* runPass();
        yield* SubscriptionRef.changes(coordinator.state).pipe(
          Stream.filter((s) => s.operations.get("/tree")?.phase === "landed"),
          Stream.runHead,
        );
        yield* runPass();
        expect(test.events).toEqual(["land", "intent:true", "resolve", "intent:false"]);
        expect((yield* requests).find((r) => r.id === "fresh")?.state).toBe("landed");
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect(
  "ordinary re-delegation retains manual readiness without inheriting the old Project Chat authority",
  () => {
    const test = fixture();
    const chatId = projectChatSessionId("/project");
    return Effect.gen(function* () {
      yield* setEnabled("/project", true);
      yield* setPurpose(target, "user", { kind: "user" });
      test.setExecutingTurns(["ordinary-turn"]);
      const delegation = yield* setPurpose(target, "delegated", {
        kind: "project-session",
        sessionId: "ordinary",
      });
      expect(delegation.owner?.sessionId).toBe("ordinary");
      expect(delegation.adoptedTurnIds).toEqual(["ordinary-turn"]);
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* settleOwnerTurn("ordinary-turn");
      const storage = yield* SessionFamilyStorage;
      // Deliver the ordinary owner's owed result before testing the authority gate.
      yield* storage.completeNotice("ordinary-turn");
      yield* runPass();
      expect((yield* requests)[0]).toMatchObject({
        state: "ready",
        readyToMerge: true,
        message: expect.stringContaining("not directly delegated"),
      });
      expect((yield* requests)[0]?.coordinatorSessionId).toBeUndefined();
      expect(test.events).toEqual([]);
      expect((yield* storage.state()).coordinatorDigest ?? []).toEqual([]);

      yield* setPurpose(target, "user", { kind: "user" });
      test.setExecutingTurns(["chat-turn"]);
      yield* setPurpose(target, "delegated", { kind: "cake-chat", sessionId: chatId });
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* settleOwnerTurn("chat-turn");
      yield* storage.completeNotice("chat-turn");
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.events).toEqual(["land", "intent:true", "resolve", "intent:false"]);
      expect((yield* storage.state()).coordinatorDigest).toMatchObject([
        {
          coordinatorSessionId: chatId,
          id: "auto-merge:chat-turn",
          autoMergeOutcome: { merged: true },
        },
      ]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["settlement", "new-input"] as const)(
  "a stale pending pass cannot overwrite real %s",
  (change) =>
    Effect.gen(function* () {
      const read = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let gate = false;
      const test = fixture({
        recordsWait: () => {
          if (!gate) return Effect.void;
          gate = false;
          return Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(resume)));
        },
      });
      yield* Effect.gen(function* () {
        yield* setEnabled("/project", true);
        expect(yield* report(target, readiness)).toEqual({ eligible: true });
        gate = true;
        const pass = yield* runPass().pipe(Effect.forkChild);
        yield* Deferred.await(read);
        if (change === "settlement") yield* settleOwnerTurn("turn");
        else yield* admitNewInput;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(pass);
        expect((yield* requests)[0]?.state).toBe(change === "settlement" ? "ready" : "canceled");
        if (change === "new-input")
          expect((yield* requests)[0]?.message).toBe("New input invalidated merge readiness");
        yield* runPass();
        if (change === "settlement") yield* terminal;
        yield* runPass();
        yield* runPass();
        expect(test.events.filter((event) => event === "land")).toHaveLength(
          change === "settlement" ? 1 : 0,
        );
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("a stale scheduler snapshot cannot claim a newer attempt with the same ready state", () =>
  Effect.gen(function* () {
    const observed = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let pause = false;
    const options = {
      failure: true,
      recordsWait: () => {
        if (!pause) return Effect.void;
        pause = false;
        return Deferred.succeed(observed, undefined).pipe(Effect.andThen(Deferred.await(resume)));
      },
    };
    const test = fixture(options);
    yield* Effect.gen(function* () {
      yield* ready;
      pause = true;
      const stale = yield* runPass().pipe(Effect.forkChild);
      yield* Deferred.await(observed);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]?.state).toBe("failed");
      yield* setEnabled("/project", false);
      yield* setEnabled("/project", true);
      options.failure = false;
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(stale);
      expect((yield* requests)[0]).toMatchObject({ state: "ready", attempt: 1 });
      expect(test.events).toEqual(["pre-git-failure"]);
      yield* runPass();
      yield* SubscriptionRef.changes((yield* WorktreeLandingCoordinator).state).pipe(
        Stream.filter((s) => s.operations.get("/tree")?.phase === "landed"),
        Stream.runHead,
      );
      yield* runPass();
      expect((yield* requests)[0]).toMatchObject({ state: "landed", attempt: 1 });
      expect(test.events.filter((event) => event === "land")).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect(
  "auto-merge follows purpose at merge time: User Sessions hold, delegating admits, moving back cancels",
  () => {
    const test = fixture({ purpose: "user" });
    return Effect.gen(function* () {
      const move = (purpose: "user" | "delegated") =>
        setPurpose(target, purpose, { kind: "user" }, "ignore");
      // Readiness is still accepted for manual landing, but never lands automatically.
      yield* ready;
      yield* runPass();
      expect(test.events).toEqual([]);
      expect((yield* requests)[0]).toMatchObject({
        readyToMerge: true,
        state: "ready",
        message: "Manual landing only: User Sessions (My sessions) never auto-merge",
      });
      // Delegating makes the same ready declaration eligible under the existing rules.
      expect((yield* move("delegated")).changed).toBe(true);
      yield* runPass();
      yield* terminal;
      expect(test.events).toEqual(expect.arrayContaining(["land", "resolve"]));
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["pending", "ready"] as const)(
  "moving a delegated session to My sessions cancels its %s auto-merge",
  (state) => {
    const test = fixture();
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* setEnabled("/project", true);
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      if (state === "ready") yield* storage.updateAutoMerge("turn", "ready");
      const change = yield* storage.setPurpose({
        sessionId: "owner",
        projectPath: "/project",
        purpose: "user",
      });
      expect(change.canceledAutoMergeIds).toEqual(["turn"]);
      expect((yield* requests)[0]).toMatchObject({ readyToMerge: false, state: "canceled" });
      yield* storage.updateAutoMerge("turn", "ready");
      yield* runPass();
      expect(test.events).toEqual([]);
      // Delegating again does not resurrect the canceled declaration.
      yield* storage.setPurpose({
        sessionId: "owner",
        projectPath: "/project",
        purpose: "delegated",
      });
      yield* runPass();
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "a landing already underway is refused at merge time once the session is a User Session",
  () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const test = fixture({ wait: Deferred.await(gate) });
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* ready;
      yield* runPass();
      expect((yield* requests)[0]?.state).toBe("landing");
      yield* storage.setPurpose({ sessionId: "owner", projectPath: "/project", purpose: "user" });
      yield* Deferred.succeed(gate, undefined);
      yield* terminal;
      yield* runPass();
      expect(test.events).not.toContain("land");
      expect((yield* requests)[0]).toMatchObject({
        state: "canceled",
        message: expect.stringContaining("Moved to My sessions"),
      });
    }).pipe(Effect.provide(test.layer));
  },
);

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
      expect(test.events.filter((item) => item === "pre-git-failure")).toHaveLength(1);
      expect(test.events.filter((item) => item === "land")).toHaveLength(1);
      expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
      expect((yield* storage.state()).coordinatorDigest?.map((item) => item.id)).toEqual([
        "auto-merge:turn",
        "auto-merge:turn:1",
      ]);
    }).pipe(Effect.provide(test.layer));
  },
);

const completedRepair = Effect.fn("test.completedRepair")(function* (
  test: ReturnType<typeof fixture>,
  id = "repair-turn",
  head = "b".repeat(40),
  outcome: "complete" | "aborted" | "failed" = "complete",
  settle = true,
) {
  const context =
    yield* Effect.context<
      Effect.Services<ReturnType<typeof report> | ReturnType<typeof makeTurnLifecycle>>
    >();
  return Effect.gen(function* () {
    const old = (yield* requests).filter((item) => item.id !== id).at(-1);
    expect(old?.readyToMerge).toBe(false);
    test.setHead(head);
    test.setExecutingTurns([id]);
    test.events.push("scoped-validation");
    expect(yield* report(target, { ...readiness, validatedCommit: head })).toEqual({
      eligible: true,
    });
    if (!settle) return;
    const hooks = yield* makeTurnLifecycle({
      sessionId: "owner",
      location: {
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: "/tree",
        sessionDirectory: "/sessions",
        resolvedSessionDirectory: "/resolved",
      },
    });
    yield* hooks.onTurnSettled({
      sessionId: "owner",
      turnId: id,
      outcome,
      result: {
        stopReason: "stop",
        text: "Repaired conflicts, committed final changes, and task-scoped validation passed.",
      },
    });
    // Like the live agent, report the outcome once settlement hooks have finished.
    return outcome;
  }).pipe(
    Effect.provide(context),
    Effect.mapError(
      (error) =>
        new WorktreeLandingAgentError({
          operation: "repair",
          message: error instanceof Error ? error.message : String(error),
        }),
    ),
  );
});

it.effect(
  "repairs, revalidates and retries only a fresh immutable commit with resolution intent",
  () => {
    const options = { conflict: true, executingTurns: ["turn"] };
    const test = fixture(options);
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(yield* completedRepair(test));
      yield* runPass();
      yield* terminal;
      const coordinator = yield* WorktreeLandingCoordinator;
      const paused = (yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree");
      expect(paused).toMatchObject({
        automatic: true,
        autoMergeRequestId: "turn",
        resolveAfterLanding: true,
        phase: "stalled",
      });
      expect(
        (yield* requests).map((item) => [
          item.id,
          item.commit,
          item.readyToMerge,
          item.repairAttempt,
        ]),
      ).toEqual([
        ["turn", commit, false, undefined],
        ["repair-turn", "b".repeat(40), true, 1],
      ]);
      expect(test.events).toEqual(["land", "repair", "scoped-validation"]);
      test.setConflict(false);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.events).toEqual([
        "land",
        "repair",
        "scoped-validation",
        "land",
        "intent:true",
        "resolve",
        "intent:false",
      ]);
      expect((yield* requests)[1]).toMatchObject({ state: "landed", commit: "b".repeat(40) });
      expect(
        (yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree")?.autoMergeRequestId,
      ).toBe("repair-turn");
      expect(test.notices).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("revalidates cleanly rebased HEAD without conflict state or an extra commit", () => {
  const rebased = "b".repeat(40);
  const test = fixture({ cleanRebaseHead: rebased });
  return Effect.gen(function* () {
    yield* ready;
    const validate = yield* completedRepair(test, "validation-turn", rebased);
    const coordinator = yield* WorktreeLandingCoordinator;
    test.setRepair(
      Effect.gen(function* () {
        const operation = (yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree");
        expect(operation).toMatchObject({ phase: "validating", pauseReason: "clean-rebase" });
        expect(operation).not.toHaveProperty("conflictFiles");
        return yield* validate;
      }),
    );
    yield* runPass();
    yield* terminal;
    expect(test.events).toEqual(["land", "revalidate", "scoped-validation"]);
    expect(test.prompts[0]).toContain(rebased);
    expect(test.prompts[0]).toContain("No new commit is needed");
    expect(test.prompts[0]).not.toMatch(/conflict|repair|git status|rebase --continue|git add/i);
    expect((yield* requests)[0]).toMatchObject({ commit, readyToMerge: false });
    expect((yield* requests)[1]).toMatchObject({
      commit: rebased,
      state: "ready",
      repairOfRequestId: "turn",
    });
    expect((yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree")).toMatchObject({
      phase: "stalled",
      pauseReason: "clean-rebase",
    });
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect((yield* requests)[1]).toMatchObject({ commit: rebased, state: "landed" });
    expect(test.events.filter((event) => event === "revalidate")).toHaveLength(1);
    expect(test.events.filter((event) => event === "resolve")).toHaveLength(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps validating clean rebases as main advances, without a turn budget", () => {
  const options = { cleanRebaseHead: "b".repeat(40) };
  const test = fixture(options);
  return Effect.gen(function* () {
    yield* ready;
    for (const [index, next] of ["b", "c", "d", "e", "f"].entries()) {
      options.cleanRebaseHead = next.repeat(40);
      test.setRepair(yield* completedRepair(test, `validation-${index}`, options.cleanRebaseHead));
      yield* runPass();
      yield* terminal;
      expect((yield* requests).at(-1)).toMatchObject({
        commit: options.cleanRebaseHead,
        state: "ready",
        readyToMerge: true,
        repairAttempt: index + 1,
      });
      expect((yield* requests).slice(0, -1).every((item) => !item.readyToMerge)).toBe(true);
      expect(test.events).not.toContain("resolve");
    }
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect((yield* requests).at(-1)).toMatchObject({ state: "landed", commit: "f".repeat(40) });
    expect(test.events.filter((event) => event === "revalidate")).toHaveLength(5);
    expect(test.events.filter((event) => event === "resolve")).toHaveLength(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("clean-rebase reminder asks only for final-HEAD validation, never repair", () => {
  const test = fixture({ cleanRebaseHead: "b".repeat(40) });
  return Effect.gen(function* () {
    yield* ready;
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect(test.prompts).toHaveLength(2);
    for (const text of test.prompts) {
      expect(text).toContain("clean-rebase validation");
      expect(text).toContain("No new commit is needed");
      expect(text).not.toMatch(/conflict|repair|git status|rebase --continue|git add/i);
    }
    expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: false });
    expect((yield* requests)[0]?.message).toContain("clean-rebase validation stopped");
    expect(test.events).not.toContain("resolve");
  }).pipe(Effect.provide(test.layer));
});

it.effect.each(["revoked", "new-input", "changed-head", "aborted", "failed", "canceled"] as const)(
  "clean-rebase revalidation never lands after %s",
  (change) => {
    const test = fixture({ cleanRebaseHead: "b".repeat(40) });
    return Effect.gen(function* () {
      yield* ready;
      const validate = yield* completedRepair(
        test,
        "validation-turn",
        "b".repeat(40),
        change === "aborted" || change === "failed" ? change : "complete",
      );
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof setEnabled>>>();
      test.setRepair(
        validate.pipe(
          // Exercise revocation while the validation turn is still running.
          Effect.tap(() => (change === "revoked" ? setEnabled("/project", false) : Effect.void)),
          Effect.provide(context),
          Effect.mapError(
            (error) =>
              new WorktreeLandingAgentError({
                operation: "revalidation",
                message: String(error),
              }),
          ),
        ),
      );
      yield* runPass();
      yield* terminal;
      if (change === "new-input") yield* (yield* SessionFamilyStorage).invalidateAutoMerge("/tree");
      if (change === "changed-head") test.setHead("c".repeat(40));
      if (change === "canceled") yield* cancel("/tree", "turn");
      yield* runPass();
      if (change === "changed-head") yield* terminal;
      expect(test.events.filter((event) => event === "land")).toHaveLength(1);
      expect(test.events).not.toContain("resolve");
      expect(test.notices).toEqual([]);
      for (const text of test.prompts)
        expect(text).not.toMatch(/conflict|repair|git status|rebase --continue/i);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("unchanged validated HEAD lands without repair or revalidation", () => {
  const test = fixture();
  return Effect.gen(function* () {
    yield* ready;
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect((yield* requests)[0]).toMatchObject({ commit, state: "landed" });
    expect(test.prompts).toEqual([]);
    expect(test.events.filter((event) => event === "land")).toHaveLength(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect.each(["complete", "aborted"] as const)(
  "resumes only after delayed real completion hooks settle (%s), without Retry",
  (outcome) => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(
        yield* completedRepair(test, "repair-turn", "b".repeat(40), "complete", false),
      );
      yield* runPass();
      yield* terminal;
      test.setConflict(false);
      yield* runPass();
      expect((yield* requests)[1]?.state).toBe("pending");
      expect(test.events.filter((item) => item === "land")).toHaveLength(1);
      const hooks = yield* makeTurnLifecycle({
        sessionId: "owner",
        location: {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/tree",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved",
        },
      });
      yield* hooks.onTurnSettled({
        sessionId: "owner",
        turnId: "repair-turn",
        outcome,
        result: {
          stopReason: "stop",
          text: "Conflict repair committed and final scoped validation passed successfully.",
        },
      });
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[1]?.state).toBe(outcome === "complete" ? "landed" : "failed");
      expect(test.events.filter((item) => item === "land")).toHaveLength(
        outcome === "complete" ? 2 : 1,
      );
      expect(test.events.includes("resolve")).toBe(outcome === "complete");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["revoked", "input", "changed-commit", "failed-turn"] as const)(
  "does not reuse repaired readiness after %s",
  (change) => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(yield* completedRepair(test));
      yield* runPass();
      yield* terminal;
      test.setConflict(false);
      if (change === "revoked") yield* setEnabled("/project", false);
      if (change === "input") yield* (yield* SessionFamilyStorage).invalidateAutoMerge("/tree");
      if (change === "changed-commit") test.setHead("c".repeat(40));
      if (change === "failed-turn") {
        yield* (yield* SessionFamilyStorage).invalidateAutoMerge("/tree");
        yield* (yield* SessionFamilyStorage).updateAutoMerge("repair-turn", "canceled");
      }
      yield* runPass();
      if (change === "changed-commit") yield* terminal;
      expect(test.events.filter((event) => event === "land")).toHaveLength(1);
      expect(test.events).not.toContain("resolve");
      expect(test.notices).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each([false, true])(
  "canceled repaired work never resumes, including an off/on cycle (%s)",
  (toggle) => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(yield* completedRepair(test));
      yield* runPass();
      yield* terminal;
      yield* cancel("/tree", "turn");
      if (toggle) {
        yield* setEnabled("/project", false);
        yield* setEnabled("/project", true);
      }
      test.setConflict(false);
      yield* runPass();
      yield* runPass();
      expect((yield* requests).every((item) => !item.readyToMerge)).toBe(true);
      expect(test.events.filter((item) => item === "land")).toHaveLength(1);
      expect(test.events).not.toContain("resolve");
      expect(test.notices).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["aborted", "failed"] as const)(
  "never automatically resumes a %s repair turn, even after readiness was declared",
  (outcome) => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(yield* completedRepair(test, "repair-turn", "b".repeat(40), outcome));
      yield* runPass();
      yield* terminal;
      test.setConflict(false);
      yield* runPass();
      expect((yield* requests)[1]).toMatchObject({ readyToMerge: false, state: "canceled" });
      expect(test.events.filter((item) => item === "land")).toHaveLength(1);
      expect(test.events).not.toContain("resolve");
      expect(test.notices).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["source content", "target commit", "conflict stages"] as const)(
  "continues repairs with changed %s, stopping only when the Git state recurs",
  (progress) => {
    const options = { conflict: true, repairFingerprint: "" };
    const test = fixture(options);
    return Effect.gen(function* () {
      yield* ready;
      for (const [index, head] of ["b", "c", "d", "e"].entries()) {
        options.repairFingerprint = JSON.stringify([
          progress === "source content" ? head : "source",
          progress === "target commit" ? head : "target",
          progress === "conflict stages" ? head : "stages",
        ]);
        test.setRepair(yield* completedRepair(test, `repair-${index}`, head.repeat(40)));
        yield* runPass();
        yield* terminal;
        expect((yield* requests).at(-1)?.state).toBe("ready");
      }
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.events.filter((event) => event === "repair")).toHaveLength(4);
      expect(test.events.filter((event) => event === "land")).toHaveLength(5);
      expect((yield* requests).at(-1)).toMatchObject({
        state: "failed",
        readyToMerge: false,
        repairAttempt: 4,
      });
      expect((yield* requests).at(-1)?.message).toContain(
        "same conflicts recurred with unchanged source content and target commit",
      );
      expect(test.events).not.toContain("resolve");
      expect(test.notices).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each([false, true])(
  "stops recurring no-progress repair despite fresh commit IDs (cycle=%s)",
  (cycle) => {
    const options = { conflict: true, repairFingerprint: "unchanged-content-and-target" };
    const test = fixture(options);
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(yield* completedRepair(test, "repair-0", "b".repeat(40)));
      yield* runPass();
      yield* terminal;
      if (cycle) {
        options.repairFingerprint = "different-content-same-target";
        test.setRepair(yield* completedRepair(test, "repair-1", "c".repeat(40)));
        yield* runPass();
        yield* terminal;
        options.repairFingerprint = "unchanged-content-and-target";
      }
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.prompts).toHaveLength(cycle ? 2 : 1);
      expect((yield* requests).at(-1)).toMatchObject({ state: "failed", readyToMerge: false });
      expect((yield* requests).at(-1)?.message).toContain("no progress, merge or resolution");
      expect(test.events).not.toContain("resolve");
      expect(test.notices).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("reports a failed repair without resurrecting validation or resolving", () => {
  const test = fixture({ conflict: true });
  return Effect.gen(function* () {
    yield* ready;
    test.setRepair(
      Effect.fail(
        new WorktreeLandingAgentError({ operation: "prompt", message: "Repair turn failed" }),
      ),
    );
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect((yield* requests)[0]).toMatchObject({
      state: "failed",
      readyToMerge: false,
      message: "Repair turn failed",
    });
    expect(test.events).not.toContain("resolve");
    expect(test.notices).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

const declareOnlyHead = { readyToMerge: true, taskCompleted: true, validationPassed: true };

/** A repair turn that ends without landable readiness, as in the observed incident. */
const invalidRepair = Effect.fn("test.invalidRepair")(function* (
  test: ReturnType<typeof fixture>,
  kind: "withdrawn" | "rejected" | "stale",
  id = "repair-turn",
) {
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof report>>>();
  return Effect.gen(function* () {
    test.setHead("b".repeat(40));
    test.setExecutingTurns([id]);
    if (kind === "rejected") {
      const error = yield* report(target, { ...readiness, validatedCommit: "2c77633cb5ed" }).pipe(
        Effect.flip,
      );
      expect(error.message).toContain(`HEAD is ${"b".repeat(40)}; you passed 2c77633cb5ed.`);
      return;
    }
    expect(yield* report(target, declareOnlyHead)).toEqual({ eligible: true });
    if (kind === "withdrawn")
      expect(yield* report(target, { ...declareOnlyHead, readyToMerge: false })).toEqual({
        eligible: false,
        reason: "Merge readiness was revoked.",
      });
    else test.setHead("c".repeat(40));
  }).pipe(
    Effect.provide(context),
    Effect.mapError(
      (error) => new WorktreeLandingAgentError({ operation: "repair", message: String(error) }),
    ),
  );
});

it.effect.each([
  { kind: "withdrawn", reason: "was withdrawn or invalidated", head: "b" },
  { kind: "rejected", reason: "No readiness was reported after the repair", head: "b" },
  { kind: "stale", reason: `but HEAD is now ${"c".repeat(40)}`, head: "c" },
] as const)(
  "re-asks once after $kind repair readiness, then lands the valid report",
  ({ kind, reason, head }) => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      const turns = [
        yield* invalidRepair(test, kind),
        yield* completedRepair(test, "reask-turn", head.repeat(40)),
      ];
      test.setRepair(Effect.suspend(() => turns.shift() ?? Effect.die("Unexpected third prompt")));
      yield* runPass();
      yield* terminal;
      expect(test.prompts).toHaveLength(2);
      expect(test.prompts[1]).toContain("Automatic landing repair is not finished");
      expect(test.prompts[1]).toContain(reason);
      expect(test.prompts[1]).toContain("This is the only reminder");
      test.setConflict(false);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests).at(-1)).toMatchObject({
        id: "reask-turn",
        commit: head.repeat(40),
        repairAttempt: 1,
        repairOfRequestId: "turn",
        state: "landed",
      });
      expect(test.events.filter((event) => event === "land")).toHaveLength(2);
      expect(test.events).toContain("resolve");
      expect(test.notices).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["off", "transfer"] as const)(
  "suppresses the repair reminder after %s during the first turn",
  (change) =>
    Effect.gen(function* () {
      const prompted = yield* Deferred.make<void>();
      const finishTurn = yield* Deferred.make<void>();
      const test = fixture({ conflict: true });
      test.setRepair(
        Deferred.succeed(prompted, undefined).pipe(Effect.andThen(Deferred.await(finishTurn))),
      );
      yield* Effect.gen(function* () {
        yield* ready;
        yield* runPass();
        yield* Deferred.await(prompted);
        if (change === "off") yield* setEnabled("/project", false);
        else yield* setPurpose(target, "user", { kind: "user" });
        yield* Deferred.succeed(finishTurn, undefined);
        yield* terminal;
        yield* runPass();
        expect(test.prompts).toHaveLength(1);
        expect(test.events).toEqual(["land", "repair"]);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("fails cleanly, with one failed outcome, when the reminder also ends invalid", () => {
  const test = fixture({ conflict: true });
  return Effect.gen(function* () {
    yield* ready;
    const turns = [Effect.void, yield* invalidRepair(test, "withdrawn", "reask-turn")];
    test.setRepair(Effect.suspend(() => turns.shift() ?? Effect.die("Unexpected third prompt")));
    yield* runPass();
    yield* terminal;
    yield* runPass();
    yield* runPass();
    expect(test.prompts).toHaveLength(2);
    expect(test.prompts[1]).toContain(
      `No readiness was reported after the repair. HEAD is ${commit}.`,
    );
    const original = (yield* requests)[0];
    expect(original).toMatchObject({ id: "turn", state: "failed", readyToMerge: false });
    expect(original?.message).toMatch(
      /^Automatic repair stopped after one reminder without fresh validated completion: Readiness for b{40} was withdrawn or invalidated .*No retry or resolution occurred\.$/,
    );
    expect(original?.outcome).toMatchObject({ merged: false, resolutionSucceeded: false });
    expect((yield* requests).every((item) => !item.readyToMerge)).toBe(true);
    expect(
      (yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state)).operations.get(
        "/tree",
      )?.phase,
    ).toBe("failed");
    expect(
      ((yield* (yield* SessionFamilyStorage).state()).coordinatorDigest ?? []).map(
        (item) => item.id,
      ),
    ).toEqual(["auto-merge:turn"]);
    expect(test.events.filter((event) => event === "land")).toHaveLength(1);
    expect(test.events).not.toContain("resolve");
  }).pipe(Effect.provide(test.layer));
});

it.effect.each(["aborted", "failed", "unknown"] as const)(
  "never re-asks a repair turn that settled %s",
  (outcome) => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(Effect.succeed(outcome));
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.prompts).toHaveLength(1);
      expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: false });
      expect((yield* requests)[0]?.message).toContain(
        outcome === "aborted"
          ? "Automatic repair turn was stopped"
          : outcome === "failed"
            ? "Automatic repair turn failed"
            : "Automatic repair turn ended with an unknown outcome",
      );
      expect(test.events).not.toContain("resolve");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("records the worktree HEAD when readiness omits the commit", () => {
  const test = fixture({ head: "c".repeat(40) });
  return Effect.gen(function* () {
    expect(yield* report(target, declareOnlyHead)).toEqual({ eligible: true });
    expect((yield* requests)[0]).toMatchObject({
      commit: "c".repeat(40),
      state: "pending",
      readyToMerge: true,
    });
    // A matching full or prefix commit is only an assertion of that same HEAD.
    expect(yield* report(target, { ...readiness, validatedCommit: "C".repeat(12) })).toEqual({
      eligible: true,
    });
    expect(yield* report(target, { ...readiness, validatedCommit: "c".repeat(40) })).toEqual({
      eligible: true,
    });
    expect(yield* requests).toHaveLength(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect.each(["d".repeat(40), "dddddddd"])(
  "rejects mismatched commit %s at call time without recording readiness",
  (validatedCommit) => {
    const test = fixture();
    return Effect.gen(function* () {
      const error = yield* report(target, { ...readiness, validatedCommit }).pipe(Effect.flip);
      expect(error.message).toBe(
        `HEAD is ${commit}; you passed ${validatedCommit}. Omit validatedCommit to declare the current HEAD, or commit the validated work first.`,
      );
      expect(yield* requests).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("rejects readiness while uncommitted or untracked files remain", () => {
  const test = fixture();
  return Effect.gen(function* () {
    test.setChangedFiles(["src/a.ts", "notes.txt"]);
    const error = yield* report(target, declareOnlyHead).pipe(Effect.flip);
    expect(error.message).toBe(
      "The worktree has 2 uncommitted or untracked file(s): src/a.ts, notes.txt. Commit or discard them first, then report readiness.",
    );
    expect(yield* requests).toEqual([]);
    test.setChangedFiles([]);
    expect(yield* report(target, declareOnlyHead)).toEqual({ eligible: true });
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "repair waiting does not block another worktree and cannot be canceled as queued Git",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = fixture({
        conflict: true,
        extraRecords: [{ ...record, worktreePath: "/other-tree" }],
      });
      yield* Effect.gen(function* () {
        yield* ready;
        test.setRepair(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        yield* runPass();
        yield* Deferred.await(entered);
        const cancelError = yield* cancel("/tree", "turn").pipe(Effect.flip);
        expect(cancelError.message).toContain("already started");
        const storage = yield* SessionFamilyStorage;
        const first = (yield* requests)[0];
        if (!first) return yield* Effect.die("Missing original request");
        yield* storage.registerSpawn({
          sessionId: "other-owner",
          projectPath: "/project",
          workingDirectory: "/other-tree",
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
          id: "other-turn",
          sessionId: "other-owner",
          workspacePath: "/other-tree",
          state: "ready",
          readyToMerge: true,
        });
        test.setConflict(false);
        yield* runPass();
        const coordinator = yield* WorktreeLandingCoordinator;
        yield* SubscriptionRef.changes(coordinator.state).pipe(
          Stream.filter((state) => state.operations.get("/other-tree")?.phase === "landed"),
          Stream.runHead,
        );
        expect(test.events.filter((event) => event === "land")).toHaveLength(2);
        yield* Deferred.succeed(release, undefined);
        yield* terminal;
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("does not resurrect pre-repair readiness through a toggle cycle", () => {
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
    expect((yield* requests)[0]?.message).toContain("fresh validated completion");
    expect((yield* requests)[0]?.readyToMerge).toBe(false);
    expect(test.events.filter((item) => item === "land")).toHaveLength(1);
    expect(test.events).not.toContain("resolve");
  }).pipe(Effect.provide(test.layer));
});

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

it.effect.each(["/project", "/other"])(
  "does not serialize automatic admission behind unrelated work in %s",
  (projectPath) => {
    const test = fixture({
      extraRecords: [{ ...record, projectPath, worktreePath: "/busy-tree" }],
    });
    return Effect.gen(function* () {
      yield* ready;
      yield* SubscriptionRef.update((yield* WorktreeLandingCoordinator).state, (state) => ({
        ...state,
        operations: new Map(state.operations).set("/busy-tree", {
          operationId: "busy",
          workspacePath: "/busy-tree",
          sessionId: "busy",
          kind: "landing",
          phase: "landing",
          allowDirtyTarget: false,
        }),
      }));
      yield* runPass();
      yield* terminal;
      expect(test.events).toContain("land");
      expect(test.events).toContain("resolve");
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
      if (change === "different-commit") test.setHead("b".repeat(40));
      const result = yield* report(
        target,
        change === "different-commit"
          ? { readyToMerge: true, taskCompleted: true, validationPassed: true }
          : readiness,
      );
      expect(result).toEqual({
        eligible: false,
        reason:
          change === "revoked"
            ? "New input invalidated merge readiness"
            : change === "previous-run"
              ? "Readiness belongs to a previous app run."
              : `This run already declared readiness for ${commit}, but HEAD is now ${"b".repeat(40)}. A run's declaration is not replaced; landing will reject the earlier commit as stale.`,
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

it.effect(
  "announces confirmed auto-merge once, not readiness, enabling, or replayed outcomes",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* ready;
      expect(test.notices).toEqual([]);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      yield* runPass();
      expect(test.notices).toHaveLength(1);
      const operation = (yield* SubscriptionRef.get(
        (yield* WorktreeLandingCoordinator).state,
      )).operations.get("/tree");
      expect(operation?.automatic).toBe(true);
      // A recovered/acknowledged terminal outcome must not re-announce the merge.
      yield* (yield* SessionFamilyStorage).updateAutoMerge("turn", "landing");
      yield* runPass();
      expect(test.notices).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("keeps successful manual landing outside the automatic announcement path", () => {
  const test = fixture({ manual: true });
  return Effect.gen(function* () {
    yield* start({
      operationId: "manual",
      workspacePath: "/tree",
      sessionId: "owner",
      strategy: "preserve",
      allowDirtyTarget: false,
      commitBeforeLanding: false,
    });
    yield* terminal;
    expect(test.events).toEqual(["land"]);
    expect(test.notices).toEqual([]);
    expect(
      (yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state)).operations.get(
        "/tree",
      )?.automatic,
    ).toBeUndefined();
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "does not broadcast or retain success when the owning project has no bound window",
  () => {
    const test = fixture({ noRecipient: true });
    return Effect.gen(function* () {
      yield* ready;
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]?.state).toBe("landed");
      expect(test.recipients).toEqual([projectChatSessionId("/project")]);
      expect(test.notices).toEqual([]);
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

it.effect.each(["off", "my-sessions", "new-input"] as const)(
  "rechecks %s after Git success before committing resolution intent",
  (change) =>
    Effect.gen(function* () {
      const landed = yield* Deferred.make<void>();
      const continueResolution = yield* Deferred.make<void>();
      const test = fixture({
        onLandedWait: Deferred.succeed(landed, undefined).pipe(
          Effect.andThen(Deferred.await(continueResolution)),
        ),
      });
      yield* Effect.gen(function* () {
        yield* ready;
        yield* runPass();
        yield* Deferred.await(landed);
        if (change === "my-sessions")
          yield* (yield* SessionFamilyStorage).setPurpose({
            sessionId: "owner",
            projectPath: "/project",
            purpose: "user",
          });
        else if (change === "new-input") yield* admitNewInput;
        else yield* setEnabled("/project", false);
        yield* Deferred.succeed(continueResolution, undefined);
        yield* terminal;
        yield* runPass();
        const outcome = (yield* requests)[0]?.outcome;
        expect(outcome).toMatchObject({
          merged: true,
          resolutionSucceeded: false,
          landedCommit: commit,
        });
        yield* setEnabled("/project", false);
        yield* setEnabled("/project", true);
        yield* runPass();
        expect(test.events).toEqual(["land"]);
        expect((yield* requests)[0]?.outcome).toEqual(outcome);
        expect((yield* (yield* SessionFamilyStorage).state()).coordinatorDigest).toMatchObject([
          { id: "auto-merge:turn", autoMergeOutcome: outcome },
        ]);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect.each([
  { conflict: true },
  { failure: true },
  { head: "b".repeat(40) },
  { resolveFailure: true },
])("keeps failed/blocked landing unresolved: %j", (options) => {
  const { head, ...fixtureOptions } = options;
  const test = fixture(fixtureOptions);
  return Effect.gen(function* () {
    yield* ready;
    // HEAD moved after validation: landing, not the declaration, rejects it.
    if (head) test.setHead(head);
    yield* runPass();
    yield* terminal;
    yield* runPass();
    expect((yield* requests)[0]).toMatchObject({
      state: "failed",
      readyToMerge: !options.conflict && !options.resolveFailure,
    });
    if (!options.resolveFailure) expect(test.events).not.toContain("resolve");
    if (options.head) expect((yield* requests)[0]?.message).toContain("Stale validated commit");
    yield* runPass();
    expect(test.events.filter((event) => event === "land").length).toBeLessThanOrEqual(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "invalidates persisted ready work on restart and never replays uncertain landing attempts",
  () => {
    const test = fixture({ savedAutoMerge: true });
    return Effect.gen(function* () {
      yield* initialize();
      expect(
        (yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state))
          .autoMergeProjects?.[0]?.enabled,
      ).toBe(true);
      const storage = yield* SessionFamilyStorage;
      for (const state of ["ready", "landing"] as const) {
        yield* storage.recordAutoMerge({
          readyToMerge: true,
          id: state,
          sessionId: "owner",
          workspacePath: "/tree",
          projectPath: "/project",
          coordinatorSessionId: projectChatSessionId("/project"),
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
  "failed manual resolve intent and a subsequent pre-Git automatic failure do not prove a merge",
  () => {
    const test = fixture({ failure: true });
    return Effect.gen(function* () {
      yield* mergeAndResolve({
        workspacePath: target.workingDirectory,
        sessionId: target.sessionId,
      });
      yield* terminal;
      expect((yield* (yield* ManagedWorktrees).records())[0]).toMatchObject({
        resolveAfterLanding: true,
        state: "active",
      });
      yield* ready;
      yield* runPass();
      yield* SubscriptionRef.changes((yield* WorktreeLandingCoordinator).state).pipe(
        Stream.filter(
          (s) =>
            s.operations.get("/tree")?.operationId === "turn" &&
            s.operations.get("/tree")?.phase === "failed",
        ),
        Stream.runHead,
      );
      yield* runPass();
      expect((yield* requests)[0]?.outcome).toMatchObject({
        merged: false,
        resolutionSucceeded: false,
      });
      expect(test.events).toEqual(["intent:true", "pre-git-failure", "pre-git-failure"]);
      expect(test.notices).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["commit", "session", "operation"] as const)(
  "ignores a resolved durable receipt for a different %s at the same workspace",
  (differs) => {
    const test = fixture({
      recovery: {
        ...record,
        state: "resolved",
        resolvedFrom: "landed",
        landedSourceCommit: commit,
        automaticLandingReceipt: {
          operationId: differs === "operation" ? "interrupted:1" : "interrupted:2",
          sessionId: differs === "session" ? "other-owner" : "owner",
          commit: differs === "commit" ? "b".repeat(40) : commit,
          resolutionAuthorized: true,
        },
      },
    });
    return Effect.gen(function* () {
      yield* (yield* SessionFamilyStorage).recordAutoMerge({
        id: "interrupted",
        attempt: 2,
        sessionId: "owner",
        workspacePath: "/tree",
        projectPath: "/project",
        epoch: "previous",
        runId: "previous",
        commit,
        state: "landing",
        readyToMerge: true,
      });
      yield* runPass();
      yield* runPass();
      expect((yield* requests)[0]?.outcome).toMatchObject({
        merged: false,
        resolutionSucceeded: false,
      });
      expect(test.events).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "recovers only resolution from durable confirmed landing intent, without replaying Git",
  () => {
    const test = fixture({
      recovery: {
        ...record,
        state: "landed",
        resolveAfterLanding: true,
        landedSourceCommit: commit,
        automaticLandingReceipt: {
          operationId: "interrupted",
          sessionId: "owner",
          commit,
          resolutionAuthorized: true,
        },
      },
    });
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
      expect(test.notices).toEqual([]);
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

it.effect.each(["off", "new-epoch", "my-sessions"] as const)(
  "does not dispatch repair if %s revokes authority after Git returns conflicts",
  (change) =>
    Effect.gen(function* () {
      const gitReturned = yield* Deferred.make<void>();
      const finishGit = yield* Deferred.make<void>();
      const test = fixture({
        conflict: true,
        afterGitWait: Deferred.succeed(gitReturned, undefined).pipe(
          Effect.andThen(Deferred.await(finishGit)),
        ),
      });
      yield* Effect.gen(function* () {
        yield* ready;
        yield* runPass();
        yield* Deferred.await(gitReturned);
        if (change === "my-sessions")
          yield* (yield* SessionFamilyStorage).setPurpose({
            sessionId: "owner",
            projectPath: "/project",
            purpose: "user",
          });
        else yield* setEnabled("/project", false);
        if (change === "new-epoch") yield* setEnabled("/project", true);
        yield* Deferred.succeed(finishGit, undefined);
        yield* terminal;
        yield* runPass();
        expect(test.events.filter((item) => item === "land")).toHaveLength(1);
        expect(test.events).not.toContain("repair");
        expect(test.events).not.toContain("resolve");
        expect((yield* requests)[0]).toMatchObject({
          state: change === "my-sessions" ? "canceled" : "failed",
          readyToMerge: false,
        });
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect.each(["revocation", "cleanup"] as const)(
  "retires canceled repair lineage after %s failure without revoking unrelated fresh readiness",
  (failure) => {
    let failWrites = false;
    let failCleanup = false;
    const test = fixture({
      conflict: true,
      failStorageWrites: () => failWrites,
      cancelWait: Effect.suspend(() =>
        failCleanup
          ? Effect.fail(
              new ManagedWorktreeError({ operation: "cancel", message: "cleanup failed" }),
            )
          : Effect.void,
      ),
    });
    return Effect.gen(function* () {
      yield* ready;
      test.setRepair(yield* completedRepair(test));
      yield* runPass();
      yield* terminal;
      expect((yield* requests)[1]).toMatchObject({
        id: "repair-turn",
        readyToMerge: true,
        repairOfRequestId: "turn",
      });
      failWrites = failure === "revocation";
      failCleanup = failure === "cleanup";
      expect((yield* cancel("/tree", "turn").pipe(Effect.result))._tag).toBe("Failure");
      const coordinator = yield* WorktreeLandingCoordinator;
      expect((yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree")).toMatchObject(
        {
          phase: "stalled",
          cancellationRequested: true,
        },
      );
      if (failWrites) {
        expect((yield* runPass().pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* requests)[1]?.readyToMerge).toBe(true);
      }
      failWrites = false;
      failCleanup = false;
      yield* setEnabled("/project", false);
      // A new task declared during cancellation is not a repair of the retired operation.
      test.setExecutingTurns(["unrelated-task"]);
      expect(yield* report(target, { ...readiness, validatedCommit: "b".repeat(40) })).toEqual({
        eligible: true,
      });
      const storage = yield* SessionFamilyStorage;
      yield* storage.updateAutoMerge("unrelated-task", "ready");
      expect((yield* requests)[2]?.repairOfRequestId).toBeUndefined();
      expect((yield* requests)[2]?.repairAttempt).toBeUndefined();
      yield* runPass();
      expect((yield* requests).slice(0, 2).every((item) => !item.readyToMerge)).toBe(true);
      expect((yield* requests)[2]?.readyToMerge).toBe(true);
      expect((yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree")).toMatchObject(
        {
          phase: "failed",
        },
      );
      expect(
        (yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree")
          ?.cancellationRequested,
      ).toBeUndefined();
      expect(test.events.filter((item) => item === "land")).toHaveLength(1);
      expect(test.events.filter((item) => item === "repair")).toHaveLength(1);
      expect(test.events).not.toContain("resolve");
      // Off/on cannot authorize the canceled repair; only the independent fresh report lands.
      test.setConflict(false);
      yield* setEnabled("/project", true);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      yield* runPass();
      expect((yield* requests)[1]?.readyToMerge).toBe(false);
      expect((yield* requests)[2]?.state).toBe("landed");
      expect(test.events.filter((item) => item === "land")).toHaveLength(2);
      expect(test.events.filter((item) => item === "repair")).toHaveLength(1);
      expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "repair error cleanup revokes only the failed declaration and its proven repair result",
  () => {
    const test = fixture({ conflict: true });
    return Effect.gen(function* () {
      yield* ready;
      const repaired = yield* completedRepair(test);
      const storage = yield* SessionFamilyStorage;
      test.setRepair(
        repaired.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const old = (yield* storage.state()).autoMergeRequests?.[0];
              if (!old) return yield* Effect.die("Missing task declaration");
              // Independent task metadata, not a repair declaration.
              yield* storage.recordAutoMerge({
                ...old,
                id: "unrelated-newer",
                commit: "b".repeat(40),
                readyToMerge: true,
                state: "ready",
              });
              return yield* new WorktreeLandingAgentError({
                operation: "repair",
                message: "repair failed after report",
              });
            }),
          ),
          Effect.mapError(
            (error) =>
              new WorktreeLandingAgentError({ operation: "repair", message: error.message }),
          ),
        ),
      );
      yield* runPass();
      yield* terminal;
      expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: false });
      expect((yield* requests)[1]).toMatchObject({ state: "canceled", readyToMerge: false });
      expect((yield* requests)[2]).toMatchObject({
        id: "unrelated-newer",
        state: "ready",
        readyToMerge: true,
      });
      expect(test.events).not.toContain("resolve");
      test.setConflict(false);
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[2]?.state).toBe("landed");
      expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "admits concurrent ready sessions to repository scheduling without stealing a running operation",
  () =>
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
        expect((yield* requests).map((item) => item.state)).toEqual(["landing", "landing"]);
        const operations = (yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state))
          .operations;
        expect(operations.get("/tree")?.operationId).toBe("turn");
        expect(operations.get("/second")?.operationId).toBe("second");
        yield* Deferred.succeed(gate, undefined);
        yield* terminal;
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect.each(["absent", "revoked"] as const)(
  "manual Merge & Resolve can replace failed automatic intent with %s readiness",
  (readinessState) => {
    const options = { conflict: true, manual: false, executingTurns: ["turn"] };
    const test = fixture(options);
    return Effect.gen(function* () {
      yield* runPass();
      expect(test.events).not.toContain("land");
      if (readinessState === "revoked") {
        yield* ready;
        yield* runPass();
        yield* terminal;
        yield* runPass();
        expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: false });
        yield* FiberMap.awaitEmpty((yield* WorktreeLandingCoordinator).fibers);
      }
      options.conflict = false;
      options.manual = true;
      yield* mergeAndResolve({ workspacePath: "/tree", sessionId: "owner" });
      yield* terminal;
      yield* runPass();
      expect(test.events.filter((item) => item === "land")).toHaveLength(
        readinessState === "revoked" ? 2 : 1,
      );
      expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "requires fresh validation after conflict, never ordinary Retry or toggle-only replay",
  () => {
    const options = { conflict: true, executingTurns: ["turn"] };
    const test = fixture(options);
    return Effect.gen(function* () {
      yield* ready;
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect((yield* requests)[0]).toMatchObject({ state: "failed", readyToMerge: false });
      options.conflict = false;
      yield* inspect({ workspacePath: "/tree", sessionId: "owner" });
      expect(
        (yield* retry({ workspacePath: "/tree", sessionId: "owner" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* setEnabled("/project", false);
      yield* setEnabled("/project", true);
      yield* runPass();
      expect(test.events.filter((item) => item === "land")).toHaveLength(1);
      expect(test.events).not.toContain("resolve");
      // B is already queued when A's fresh readiness arrives: no scheduler cycle.
      yield* SubscriptionRef.update((yield* WorktreeLandingCoordinator).state, (state) => ({
        ...state,
        operations: new Map(state.operations).set("/other-tree", {
          operationId: "queued-b",
          workspacePath: "/other-tree",
          sessionId: "b",
          kind: "landing",
          phase: "queued",
          allowDirtyTarget: false,
        }),
      }));
      options.executingTurns = ["repair-turn"];
      expect(yield* report(target, readiness)).toEqual({ eligible: true });
      yield* (yield* SessionFamilyStorage).updateAutoMerge("repair-turn", "ready");
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.events.filter((item) => item === "land")).toHaveLength(2);
      expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
      expect((yield* requests).find((item) => item.id === "repair-turn")?.state).toBe("landed");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each([
  { action: "cancel", attempt: 0 },
  { action: "cancel", attempt: 1 },
  { action: "acknowledge", attempt: 0 },
  { action: "acknowledge", attempt: 1 },
] as const)(
  "durably revokes $action attempt $attempt before scheduler observation",
  ({ action, attempt }) => {
    const options = { conflict: false, failure: attempt === 1, executingTurns: ["turn"] };
    const test = fixture(options);
    return Effect.gen(function* () {
      if (action === "cancel") yield* trackOwner;
      yield* ready;
      if (attempt === 1) {
        yield* runPass();
        yield* terminal;
        yield* runPass();
        yield* setEnabled("/project", false);
        yield* setEnabled("/project", true);
      }
      options.failure = action === "acknowledge";
      options.conflict = action === "cancel";
      if (action === "cancel") test.setRepair(yield* completedRepair(test));
      yield* runPass();
      yield* terminal;
      const operationId = attempt ? "turn:1" : "turn";
      const coordinator = yield* WorktreeLandingCoordinator;
      expect((yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree")).toMatchObject(
        {
          operationId,
          autoMergeRequestId: "turn",
          phase: action === "cancel" ? "stalled" : "failed",
        },
      );
      if (attempt === 1) {
        yield* cancel("/tree", "turn");
        yield* acknowledge("/tree", "turn");
        expect((yield* requests)[0]?.readyToMerge).toBe(action === "acknowledge");
        expect(
          (yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree")?.operationId,
        ).toBe("turn:1");
      }
      // Deliberately no runPass between the pause/failure and its retirement.
      expect((yield* requests)[0]?.state).toBe(action === "cancel" ? "canceled" : "landing");
      const landings = test.events.filter((item) => item === "land").length;
      yield* action === "cancel" ? cancel("/tree", operationId) : acknowledge("/tree", operationId);
      expect(
        (yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree"),
      ).toBeUndefined();
      expect((yield* requests)[0]).toMatchObject({ state: "canceled", readyToMerge: false });
      expect(
        JSON.parse(test.files.get("state/session-families.json") ?? "{}").data.autoMergeRequests[0],
      ).toMatchObject({ id: "turn", readyToMerge: false });
      // A conflict repair has a new HEAD; retirement must revoke its linked declaration too.
      if (action === "cancel") {
        expect((yield* requests)[1]?.readyToMerge).toBe(false);
        yield* reviews.reconcile();
        expect((yield* tracked).attentionReason).toContain("Automatic landing canceled");
      }
      options.conflict = false;
      options.failure = false;
      yield* setEnabled("/project", false);
      yield* setEnabled("/project", true);
      yield* runPass();
      yield* runPass();
      expect(test.events.filter((item) => item === "land")).toHaveLength(landings);
      expect(test.events).not.toContain("resolve");
      expect(yield* report(target, declareOnlyHead)).toMatchObject({ eligible: false });
      test.setExecutingTurns(["fresh-repair-turn"]);
      expect(
        yield* report(target, {
          ...readiness,
          validatedCommit: action === "cancel" ? "b".repeat(40) : commit,
        }),
      ).toEqual({ eligible: true });
      yield* (yield* SessionFamilyStorage).updateAutoMerge("fresh-repair-turn", "ready");
      yield* runPass();
      yield* terminal;
      yield* runPass();
      expect(test.events.filter((item) => item === "land")).toHaveLength(landings + 1);
      expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("stale retirement cannot revoke a newer operation or a newer declaration", () => {
  const options = { failure: true, executingTurns: ["turn"] };
  const test = fixture(options);
  return Effect.gen(function* () {
    yield* ready;
    yield* runPass();
    yield* terminal;
    // A fresh declaration may exist before the old operation is dismissed.
    options.executingTurns = ["new-declaration"];
    yield* report(target, readiness);
    const storage = yield* SessionFamilyStorage;
    yield* storage.updateAutoMerge("new-declaration", "ready");
    yield* acknowledge("/tree", "turn");
    expect((yield* requests).find((item) => item.id === "new-declaration")).toMatchObject({
      readyToMerge: true,
      state: "ready",
    });
    yield* runPass();
    yield* terminal;
    yield* cancel("/tree", "turn");
    yield* acknowledge("/tree", "turn");
    expect(
      (yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state)).operations.get(
        "/tree",
      ),
    ).toMatchObject({ operationId: "new-declaration", autoMergeRequestId: "new-declaration" });
    expect((yield* requests).find((item) => item.id === "new-declaration")?.readyToMerge).toBe(
      true,
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "acknowledgment revokes the same declaration even if a toggle already advanced its attempt",
  () =>
    Effect.gen(function* () {
      const authorized = yield* Deferred.make<void>();
      const publishEpoch = yield* Deferred.make<void>();
      const test = fixture({ failure: true });
      yield* Effect.gen(function* () {
        yield* ready;
        yield* runPass();
        yield* terminal;
        yield* runPass();
        yield* setEnabled("/project", false);
        const storage = yield* SessionFamilyStorage;
        const toggling = yield* setEnabled("/project", true).pipe(
          Effect.provideService(SessionFamilyStorage, {
            ...storage,
            authorizeAutoMerge: (...args) =>
              storage
                .authorizeAutoMerge(...args)
                .pipe(
                  Effect.andThen(Deferred.succeed(authorized, undefined)),
                  Effect.andThen(Deferred.await(publishEpoch)),
                ),
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(authorized);
        expect((yield* requests)[0]).toMatchObject({ attempt: 1, readyToMerge: true });
        yield* acknowledge("/tree", "turn");
        yield* Deferred.succeed(publishEpoch, undefined);
        yield* Fiber.join(toggling);
        yield* runPass();
        expect((yield* requests)[0]).toMatchObject({ attempt: 1, readyToMerge: false });
        expect(test.events).toEqual(["pre-git-failure"]);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("cancellation commits revocation before cleanup and toggle reauthorization", () =>
  Effect.gen(function* () {
    const retiring = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const test = fixture({
      conflict: true,
      cancelWait: Deferred.succeed(retiring, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
      ),
    });
    yield* Effect.gen(function* () {
      yield* ready;
      test.setRepair(yield* completedRepair(test));
      yield* runPass();
      yield* terminal;
      const storage = yield* SessionFamilyStorage;
      const canceling = yield* cancel("/tree", "turn").pipe(Effect.forkScoped);
      yield* Deferred.await(retiring);
      expect((yield* requests)[0]?.readyToMerge).toBe(false);
      const state = yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
      yield* storage.authorizeAutoMerge(
        state.autoMergeRunId ?? "",
        "racing-epoch",
        "/project",
        projectChatSessionId("/project"),
      );
      expect((yield* requests)[0]?.readyToMerge).toBe(false);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(canceling);
      yield* setEnabled("/project", false);
      yield* setEnabled("/project", true);
      yield* runPass();
      expect(test.events.filter((item) => item === "land")).toHaveLength(1);
      expect(test.events).not.toContain("resolve");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("a scheduler snapshot taken before retirement cannot reuse the revoked declaration", () =>
  Effect.gen(function* () {
    const starting = yield* Deferred.make<void>();
    const continueStart = yield* Deferred.make<void>();
    const options = { failure: true, statusWait: Effect.void };
    const test = fixture(options);
    yield* Effect.gen(function* () {
      yield* ready;
      yield* runPass();
      yield* terminal;
      yield* runPass();
      yield* setEnabled("/project", false);
      yield* setEnabled("/project", true);
      options.failure = false;
      // Pause the stale scheduler after it read ready metadata, before operation insertion.
      options.statusWait = Deferred.succeed(starting, undefined).pipe(
        Effect.andThen(Deferred.await(continueStart)),
      );
      const scheduling = yield* runPass().pipe(Effect.forkScoped);
      yield* Deferred.await(starting);
      yield* acknowledge("/tree", "turn");
      expect((yield* requests)[0]?.readyToMerge).toBe(false);
      yield* Deferred.succeed(continueStart, undefined);
      yield* Fiber.join(scheduling);
      yield* terminal;
      yield* runPass();
      yield* setEnabled("/project", false);
      yield* setEnabled("/project", true);
      yield* runPass();
      expect((yield* requests)[0]?.readyToMerge).toBe(false);
      expect(test.events).toEqual(["pre-git-failure"]);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("successful acknowledgment retains the confirmed outcome without replay", () => {
  const test = fixture();
  return Effect.gen(function* () {
    yield* ready;
    yield* runPass();
    yield* terminal;
    yield* acknowledge("/tree", "turn");
    yield* runPass();
    yield* runPass();
    expect((yield* requests)[0]).toMatchObject({
      state: "landed",
      outcome: { merged: true, resolutionSucceeded: true },
    });
    expect(test.events.filter((item) => item === "land")).toHaveLength(1);
    expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect.each([false, true])(
  "retains cancellation through a queued worker and revocation-write failure (newer declaration=%s)",
  (newerDeclaration) =>
    Effect.gen(function* () {
      const queue = yield* makeWorktreeLandingQueue(() => Effect.succeed("/repository"));
      const blocker = { ...record, worktreePath: "/blocker" };
      yield* queue.acquireLanding(blocker, "blocker");
      let failWrites = false;
      const options = { queue, failStorageWrites: () => failWrites, executingTurns: ["turn"] };
      const test = fixture(options);
      yield* Effect.gen(function* () {
        const coordinator = yield* WorktreeLandingCoordinator;
        const waitQueued = SubscriptionRef.changes(coordinator.state).pipe(
          Stream.filter((state) => state.operations.get("/tree")?.phase === "queued"),
          Stream.runHead,
        );
        yield* ready;
        yield* runPass();
        yield* waitQueued;
        failWrites = true;
        expect((yield* cancel("/tree", "turn").pipe(Effect.result))._tag).toBe("Failure");
        // The real FIFO fails its Deferred waiter; the real domain worker publishes failed.
        yield* terminal;
        expect(
          (yield* SubscriptionRef.get(coordinator.state)).operations.get("/tree"),
        ).toMatchObject({
          phase: "failed",
          cancellationRequested: true,
          autoMergeRequestId: "turn",
        });
        expect(yield* queue.landingState(record)).toBeUndefined();
        expect(yield* queue.landingState(blocker)).toMatchObject({
          state: "running",
          operationId: "blocker",
        });
        expect((yield* requests)[0]?.readyToMerge).toBe(true);
        expect(
          (yield* retry({ workspacePath: "/tree", sessionId: "owner" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* runPass().pipe(Effect.result))._tag).toBe("Failure");
        expect(test.events).not.toContain("land");
        expect(test.events).not.toContain("repair");
        expect(test.events).not.toContain("resolve");
        failWrites = false;
        const storage = yield* SessionFamilyStorage;
        if (newerDeclaration) {
          options.executingTurns = ["fresh-after-cancel"];
          yield* report(target, readiness);
          yield* storage.updateAutoMerge("fresh-after-cancel", "ready");
        }
        yield* runPass();
        expect((yield* requests).find((item) => item.id === "turn")?.readyToMerge).toBe(false);
        expect(
          JSON.parse(
            test.files.get("state/session-families.json") ?? "{}",
          ).data.autoMergeRequests.find((item: { id: string }) => item.id === "turn").readyToMerge,
        ).toBe(false);
        if (newerDeclaration) {
          expect(
            (yield* requests).find((item) => item.id === "fresh-after-cancel")?.readyToMerge,
          ).toBe(true);
          yield* waitQueued;
          yield* cancel("/tree", "turn");
          yield* acknowledge("/tree", "turn");
          expect(
            (yield* requests).find((item) => item.id === "fresh-after-cancel")?.readyToMerge,
          ).toBe(true);
        } else {
          yield* setEnabled("/project", false);
          yield* setEnabled("/project", true);
          yield* runPass();
          expect(yield* queue.landingState(record)).toBeUndefined();
        }
        yield* queue.releaseLanding(blocker, "blocker");
        const worker = yield* FiberMap.get(coordinator.fibers, "/tree");
        if (Option.isSome(worker)) yield* Fiber.join(worker.value);
        if (!newerDeclaration) {
          // No HEAD change: only durable cancellation, not the commit guard, blocks replay.
          expect(test.events).not.toContain("land");
          expect(test.events).not.toContain("resolve");
          options.executingTurns = ["fresh-after-cancel"];
          expect(yield* report(target, readiness)).toEqual({ eligible: true });
          yield* storage.updateAutoMerge("fresh-after-cancel", "ready");
          yield* runPass();
          yield* terminal;
        }
        yield* runPass();
        expect(test.events.filter((item) => item === "land")).toHaveLength(1);
        expect(test.events.filter((item) => item === "resolve")).toHaveLength(1);
        expect((yield* requests).find((item) => item.id === "fresh-after-cancel")?.state).toBe(
          "landed",
        );
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect("failed acknowledgment retains revocation intent across toggle reauthorization", () => {
  let failWrites = false;
  const options = { failure: true, failStorageWrites: () => failWrites };
  const test = fixture(options);
  return Effect.gen(function* () {
    yield* ready;
    yield* runPass();
    yield* terminal;
    yield* runPass();
    failWrites = true;
    expect((yield* acknowledge("/tree", "turn").pipe(Effect.result))._tag).toBe("Failure");
    expect(
      (yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state)).operations.get(
        "/tree",
      ),
    ).toMatchObject({ phase: "failed", cancellationRequested: true });
    failWrites = false;
    options.failure = false;
    yield* setEnabled("/project", false);
    yield* setEnabled("/project", true);
    expect((yield* requests)[0]).toMatchObject({ attempt: 1, readyToMerge: true });
    yield* runPass();

    expect((yield* requests)[0]?.readyToMerge).toBe(false);
    expect(test.events).toEqual(["pre-git-failure"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("failed durable revocation does not retire an automatic operation", () => {
  const test = fixture({ conflict: true });
  return Effect.gen(function* () {
    yield* ready;
    test.setRepair(yield* completedRepair(test));
    yield* runPass();
    yield* terminal;
    const storage = yield* SessionFamilyStorage;
    const result = yield* cancel("/tree", "turn").pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        invalidateAutoMerge: () =>
          Effect.fail(new SessionFamilyStorageError({ operation: "save", message: "disk full" })),
      }),
      Effect.result,
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { message: "disk full" } });
    expect(
      (yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state)).operations.get(
        "/tree",
      ),
    ).toMatchObject({ phase: "stalled", cancellationRequested: true });
    expect(test.events).not.toContain("resolve");
  }).pipe(Effect.provide(test.layer));
});
