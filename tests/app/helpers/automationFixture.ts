import { NodePath } from "@effect/platform-node-shared";
import { Context, Deferred, Effect, FileSystem, Layer, Queue, Ref, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTaskInputStorageLive } from "../../../src/services/storage/TaskInputStorageLive";
import type { AutomationDefinition } from "../../../src/contracts/automations/automation-data";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/contracts/application/application-data";
import { AutomationRecords } from "../../../src/services/automations/AutomationRecords";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  AutomationStorage,
  type AutomationLedger,
} from "../../../src/services/storage/AutomationStorage";
import { AutomationConfiguration } from "../../../src/services/automations/AutomationConfiguration";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimeSetup,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import { OptMemory } from "../../../src/services/opt-memory/OptMemory";
import type {
  RuntimeRecoveryInput,
  RuntimeRecoveryRecord,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import type { CakeSessionRuntime } from "../../../src/services/pi/runtime/cake-session-runtime";
import { TurnCanceledError } from "../../../src/services/pi/runtime/RuntimeTurnCompletion";
import { makeProjectSessionRuntimeTestLayer } from "../domain/projectSessionRuntimeTestLayer";
import { WorkflowTestLive } from "./workflowFixture";
import { familyStorageHarness } from "./familyStorageHarness";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { fakeRuntime, makeRuntimeRecoveryStorageTestLayer, snapshot } from "./piRuntimeFixture";

export const automationDefinition = (
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition => ({
  name: "Morning brief",
  context: { _tag: "Global" },
  trigger: {
    _tag: "Schedule",
    schedule: { _tag: "Interval", startsAt: "2030-01-01T09:00:00.000Z", everySeconds: 86_400 },
  },
  task: {
    prompt: "Summarize what needs attention.",
    configuration: { provider: "test", modelId: "test", thinkingLevel: "off", fastMode: false },
    attachments: [],
  },
  overlap: "skip",
  completion: "keep-for-review",
  ...overrides,
});

export const automationFixture = Effect.fn("AutomationFixture.make")(function* (
  initial: {
    readonly ledger?: AutomationLedger;
    readonly recovery?: ReadonlyArray<RuntimeRecoveryRecord>;
  } = {},
) {
  const inputDirectory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-automation-inputs-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const persisted = yield* Ref.make<AutomationLedger>(
    initial.ledger ?? {
      automations: [],
      occurrences: [],
      runs: [],
    },
  );
  const storage = Layer.succeed(AutomationStorage, {
    load: () => Ref.get(persisted),
    save: (value) => Ref.set(persisted, value),
  });
  const started = yield* Queue.unbounded<{
    sessionId: string;
    text: string;
    options: CakeSessionRuntimeSetup;
    attachments: readonly Attachment[];
    turnId: string;
  }>();
  const completions = new Map<
    string,
    Map<string, { completion: Deferred.Deferred<void, Error>; idle: Deferred.Deferred<void> }>
  >();
  const pendingTurn = (sessionId: string, turnId?: string) => {
    const turns = completions.get(sessionId);
    return turnId === undefined ? turns?.values().next().value : turns?.get(turnId);
  };
  const disposed = yield* Queue.unbounded<string>();
  const captured: CakeSessionRuntimeSetup[] = [];
  const recoveredInputs = yield* Queue.unbounded<RuntimeRecoveryInput>();
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    changelog: () => Effect.succeed(""),
    createRuntime: (options) =>
      Effect.sync(() => {
        const sessionId = options.sessionId ?? "unexpected-missing-id";
        const pending = new Map<
          string,
          { completion: Deferred.Deferred<void, Error>; idle: Deferred.Deferred<void> }
        >();
        completions.set(sessionId, pending);
        captured.push(options);
        const runtime: CakeSessionRuntime = {
          ...fakeRuntime(options, () => {
            Effect.runSync(Queue.offer(disposed, sessionId));
          }),
          sessionId,
          sessionFile: `/sessions/${sessionId}.jsonl`,
          get streaming() {
            return pending.size > 0;
          },
          executingTurnIds: () => [...pending.keys()],
          snapshot: async () => ({
            ...snapshot,
            sessionId,
            streaming: pending.size > 0,
            workspacePath: options.cwd,
          }),
          prompt: async (
            text: string,
            _delivery: "prompt" | "steer" | "follow-up",
            attachments: Attachment[],
            _markdown?: boolean,
            turnId?: string,
          ) => {
            if (!turnId) throw new Error("The managed runtime must supply an accepted turn ID");
            const turn = {
              completion: Deferred.makeUnsafe<void, Error>(),
              idle: Deferred.makeUnsafe<void>(),
            };
            pending.set(turnId, turn);
            options.onInitialTranscriptPersisted?.();
            Effect.runSync(Queue.offer(started, { sessionId, text, options, attachments, turnId }));
            try {
              await Effect.runPromise(Deferred.await(turn.completion));
            } finally {
              pending.delete(turnId);
              Deferred.doneUnsafe(turn.idle, Effect.void);
            }
          },
          recoverInput: (input) => {
            Queue.offerUnsafe(recoveredInputs, input);
            return runtime.prompt(
              input.text,
              input.delivery,
              [...input.attachments],
              input.markdown,
              input.turnId,
              input.presentationMode,
              input.automaticTitle,
              input.responseMode,
              input.internal,
            );
          },
          abort: async () => {
            const active = [...pending.values()];
            for (const turn of active)
              Deferred.doneUnsafe(turn.completion, Effect.fail(new TurnCanceledError("Stopped")));
            await Promise.all(active.map((turn) => Effect.runPromise(Deferred.await(turn.idle))));
          },
        };
        return runtime;
      }),
  }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer(initial.recovery)));
  const resolved = yield* Ref.make<ReadonlySet<string>>(new Set());
  const archive = Layer.mock(SessionArchiveStorage, {
    recordedResolvedIds: () => Ref.get(resolved),
    resolve: (id) => Ref.update(resolved, (ids) => new Set([...ids, id])).pipe(Effect.as(true)),
    restore: (id) =>
      Ref.update(resolved, (ids) => new Set([...ids].filter((item) => item !== id))).pipe(
        Effect.as(true),
      ),
  });
  let application: ApplicationStateValue = {
    ...defaultApplicationState(),
    trustedProjectPaths: ["/projects/cake"],
    projects: [
      {
        path: "/projects/cake",
        name: "Cake",
        addedAt: "2025-01-01T00:00:00.000Z",
        lastOpenedAt: "2025-01-01T00:00:00.000Z",
      },
    ],
  };
  let projectAvailable = true;
  const layer = Layer.mergeAll(
    WorkflowTestLive,
    makeProjectSessionRuntimeTestLayer(),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      awaitSetup: () => Effect.void,
    }),
    familyStorageHarness().layer,
    AutomationRecords.layer.pipe(Layer.provide(storage)),
    runtimes,
    archive,
    NodePath.layer,
    Layer.mock(ApplicationState, {
      snapshot: () => application,
      transact: (transition) =>
        transition(application).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              application = next;
            }),
          ),
        ),
    }),
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.succeed(projectAvailable) }),
    ),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
    Layer.succeed(AutomationConfiguration, { homeDirectory: "/home/user" }),
    Layer.succeed(OptMemory, {
      read: () => Effect.succeed({ lines: [], bytes: 0, budgetBytes: 10_000, sourceCount: 0 }),
      zoom: () => Effect.die("Unexpected Zoom"),
      write: () => Effect.die("Unexpected memory write"),
    }),
    makeTaskInputStorageLive(inputDirectory),
  );
  const context = yield* Layer.build(layer);
  yield* Context.get(context, AutomationRecords).initialize();
  return {
    context,
    inputDirectory,
    started,
    disposed,
    captured,
    recoveredInputs,
    setProjectAvailable: (available: boolean) => {
      projectAvailable = available;
    },
    persisted,
    resolved,
    records: Context.get(context, AutomationRecords),
    sessions: Context.get(context, CakeSessionRuntimes),
    fail: (sessionId: string, turnId?: string) => {
      const completion = pendingTurn(sessionId, turnId)?.completion;
      return completion
        ? Deferred.fail(completion, new Error("Provider rejected the request"))
        : Effect.die(`Unknown test session ${sessionId}`);
    },
    complete: (sessionId: string, turnId?: string) => {
      const completion = pendingTurn(sessionId, turnId)?.completion;
      return completion
        ? Deferred.succeed(completion, undefined)
        : Effect.die(`Unknown test session ${sessionId}`);
    },
  };
});
