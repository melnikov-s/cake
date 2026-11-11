import type { Clock } from "effect";
import {
  Deferred,
  Effect,
  Equal,
  Exit,
  Hash,
  PubSub,
  RcMap,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect";
import { shutdownDiagnostics, shutdownResource } from "../diagnostics/shutdown-diagnostics";
import { startupDiagnostics } from "../diagnostics/startup-diagnostics";
import type { RuntimeRecoveryStorage } from "../storage/RuntimeRecoveryStorage";
import type { PiTurnResult } from "../../contracts/pi/turn-result-data";
import {
  PiSessionError,
  type CakeSessionRuntimeAcquireOptions,
  type CakeSessionRuntimesAdapter,
  type PiSessionEvent,
} from "./CakeSessionRuntimes";
import type { CakeSessionRuntime } from "./runtime/cake-session-runtime";
import { sessionError } from "./session-runtime-operations";

export const PiSessionCapabilityProfile = Schema.TaggedUnion({
  AutomationSession: {},
  ProjectSession: {},
  CakeChatSession: {},
  DiscussionSession: {},
  SubagentSession: {},
});

import type { SessionModelSwitchStatus } from "../../contracts/conversations/session-model-switch";

export interface SharedRuntime {
  modelSwitch?: SessionModelSwitchStatus;
  applicationLease: boolean;
  readonly fingerprint: string;
  readonly acquireOptions: CakeSessionRuntimeAcquireOptions;
  readonly workingDirectory: string;
  readonly sessionDirectory: string;
  readonly profile: CakeSessionRuntimeAcquireOptions["profile"]["_tag"];
  readonly runtime: CakeSessionRuntime;
  readonly events: PubSub.PubSub<PiSessionEvent>;
  readonly initialTranscriptPersisted: Deferred.Deferred<void>;
  readonly activeTurns: Ref.Ref<ReadonlyMap<string, "prompt" | "steer" | "follow-up">>;
  readonly activityTiming: { startedAt: number | undefined };
  readonly settledInputIds: Set<string>;
  readonly turnResults: Map<string, PiTurnResult>;
  readonly queueEdits: Semaphore.Semaphore;
  readonly turnAdmissions: Semaphore.Semaphore;
}

class RuntimeKey implements Equal.Equal {
  readonly fingerprint: string;
  constructor(
    readonly target: string,
    readonly options: CakeSessionRuntimeAcquireOptions,
  ) {
    this.fingerprint = runtimeFingerprint(options);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof RuntimeKey && this.target === that.target;
  }
  [Hash.symbol](): number {
    return Hash.string(this.target);
  }
}

export const runtimeTarget = (options: CakeSessionRuntimeAcquireOptions): string => {
  const runtime = options.runtime;
  const identity =
    runtime.sessionId ?? runtime.sessionFile ?? (runtime.newSession ? "new" : "recent");
  return `${runtime.cwd}\u0000${runtime.sessionDir}\u0000${identity}`;
};

const runtimeFingerprint = (options: CakeSessionRuntimeAcquireOptions): string => {
  const runtime = options.runtime;
  return JSON.stringify({
    profile: options.profile,
    cwd: runtime.cwd,
    agentDir: runtime.agentDir,
    sessionDir: runtime.sessionDir,
    directSessionDir: runtime.directSessionDir ?? false,
    // Once a caller creates an explicit session ID, later open/command
    // acquisitions address that same runtime. Creation mode is not a lasting
    // runtime policy and therefore is not part of the conflict fingerprint.
    sessionId: runtime.sessionId,
    sessionFile: runtime.sessionFile,
    tools: runtime.tools ? [...runtime.tools].sort() : undefined,
    auxiliary: runtime.auxiliary ?? false,
    ephemeral: runtime.ephemeral ?? false,
    projectInvestigation: runtime.projectInvestigation ?? false,
    allowMutations: runtime.allowMutations ?? false,
    alwaysAutoCompact: runtime.alwaysAutoCompact ?? false,
    isolatedSystemPrompt: runtime.isolatedSystemPrompt,
    slashCommands: runtime.slashCommands,
    // Relationship context is regenerated on acquisition and may change when a
    // standalone session is promoted. It does not redefine the live Pi runtime.
    hasGlobalControl: runtime.globalControl !== undefined,
    hasSessionControl: runtime.sessionControl !== undefined,
    hasAgentControl: runtime.agentControl !== undefined,
    hasAutomationControl: runtime.automationControl !== undefined,
  });
};

const validateProfile = Effect.fn("CakeSessionRuntimes.validateProfile")(function* (
  options: CakeSessionRuntimeAcquireOptions,
) {
  const decoded = yield* Schema.decodeUnknownEffect(PiSessionCapabilityProfile)(
    options.profile,
  ).pipe(sessionError("acquire"));
  const profile = decoded._tag;
  const runtime = options.runtime;
  const valid =
    ((profile === "ProjectSession" || profile === "AutomationSession") &&
      !runtime.auxiliary &&
      !runtime.globalControl &&
      !runtime.sessionControl) ||
    (profile === "CakeChatSession" &&
      runtime.globalControl !== undefined &&
      !runtime.auxiliary &&
      !runtime.sessionControl) ||
    profile === "DiscussionSession" ||
    (profile === "SubagentSession" &&
      runtime.auxiliary === true &&
      runtime.globalControl === undefined &&
      runtime.sessionControl === undefined);
  if (valid && (!runtime.projectInvestigation || profile === "SubagentSession")) return;
  return yield* new PiSessionError({
    operation: "acquire",
    message: `Runtime options conflict with the ${profile} capability profile`,
  });
});

export const makeSessionRuntimeRegistry = Effect.fn("CakeSessionRuntimes.makeRegistry")(
  function* (input: {
    readonly adapter: CakeSessionRuntimesAdapter;
    readonly clock: Clock.Clock;
    readonly recoveryStorage: RuntimeRecoveryStorage["Service"];
    readonly recoveryGate: Semaphore.Semaphore;
    readonly layerScope: Scope.Scope;
  }) {
    const { adapter, clock, recoveryStorage, recoveryGate, layerScope } = input;
    // RcMap remains the sole resource owner. This set is only a process-local projection used
    // to fan explicit refresh intents to currently acquired runtimes; it never acquires or
    // retains a runtime.
    const activeRuntimes = new Set<SharedRuntime>();
    // RcMap is the process-local keyed resource owner. Each acquire retains a
    // reference in its caller Scope; the final release disposes the one Pi
    // runtime. Equal/Hash intentionally key only by Pi Session target, while
    // the fingerprint below rejects conflicting runtime-defining options.
    const runtimes = yield* RcMap.make({
      lookup: (key: RuntimeKey) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            yield* key.options.onInitialize ?? Effect.void;
            const events = yield* PubSub.unbounded<PiSessionEvent>();
            const activityEvents = yield* PubSub.subscribe(events);
            yield* Stream.fromSubscription(activityEvents).pipe(
              Stream.filter((event) => event.type === "streaming"),
              Stream.runForEach(() => key.options.onTurnActivityChanged ?? Effect.void),
              Effect.forkScoped,
            );
            const activeTurns = yield* Ref.make<
              ReadonlyMap<string, "prompt" | "steer" | "follow-up">
            >(new Map());
            const settledInputIds = new Set<string>();
            const activityTiming: SharedRuntime["activityTiming"] = { startedAt: undefined };
            const turnResults = new Map<string, PiTurnResult>();
            const initialTranscriptPersisted = yield* Deferred.make<void>();
            if (
              (key.options.profile._tag === "ProjectSession" ||
                key.options.profile._tag === "AutomationSession") &&
              key.options.runtime.newSession
            )
              yield* Deferred.await(initialTranscriptPersisted).pipe(
                Effect.andThen(key.options.onSessionChanged ?? Effect.void),
                Effect.andThen(key.options.onSessionCreated ?? Effect.void),
                Effect.orDie,
                Effect.forkScoped,
              );
            let currentRuntime: CakeSessionRuntime | undefined = undefined;
            const runtime = yield* adapter
              .createRuntime({
                ...key.options.runtime,
                onInitialTranscriptPersisted() {
                  Deferred.doneUnsafe(initialTranscriptPersisted, Effect.void);
                },
                onTurnResult(turnId, result) {
                  turnResults.set(turnId, result);
                },
                onEvent(event) {
                  if (event.type === "streaming") {
                    if (event.streaming)
                      activityTiming.startedAt ??= clock.currentTimeMillisUnsafe();
                    else {
                      for (const id of currentRuntime?.executingTurnIds?.() ?? [])
                        settledInputIds.add(id);
                      if (
                        ![...Ref.getUnsafe(activeTurns)].some(
                          ([id, delivery]) => delivery !== "follow-up" && !settledInputIds.has(id),
                        )
                      )
                        activityTiming.startedAt = undefined;
                    }
                  }
                  const projected: PiSessionEvent =
                    event.type === "snapshot"
                      ? { type: "snapshot-updated", snapshot: event.snapshot }
                      : event;
                  PubSub.publishUnsafe(events, projected);
                },
              })
              .pipe((effect) =>
                startupDiagnostics.measure("session-runtime-construct", effect).pipe(
                  Effect.annotateLogs({
                    sessionId: key.options.runtime.sessionId,
                    profile: key.options.profile._tag,
                  }),
                ),
              );
            currentRuntime = runtime;
            if (key.options.runtime.newSession && key.options.profile._tag !== "DiscussionSession")
              yield* Deferred.await(initialTranscriptPersisted).pipe(
                Effect.andThen(
                  recoveryGate.withPermit(
                    Effect.gen(function* () {
                      const record = yield* recoveryStorage.get(runtime.sessionId);
                      if (record && !record.transcriptPersisted)
                        yield* recoveryStorage.update({ ...record, transcriptPersisted: true });
                    }),
                  ),
                ),
                Effect.orDie,
                Effect.forkScoped,
              );
            const shared: SharedRuntime = {
              applicationLease: false,
              initialTranscriptPersisted,
              settledInputIds,
              turnResults,
              fingerprint: key.fingerprint,
              acquireOptions: key.options,
              workingDirectory: key.options.runtime.cwd,
              sessionDirectory: key.options.runtime.sessionDir,
              profile: key.options.profile._tag,
              runtime,
              events,
              activeTurns,
              activityTiming,
              queueEdits: Semaphore.makeUnsafe(1),
              turnAdmissions: Semaphore.makeUnsafe(1),
            };
            activeRuntimes.add(shared);
            return shared;
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? shutdownDiagnostics.effect(
                    "runtime.onRelease",
                    shutdownResource(key.options.runtime.sessionId ?? runtimeTarget(key.options)),
                    (key.options.onRelease ?? Effect.void).pipe(Effect.orDie),
                  )
                : Effect.void,
            ),
          ),
          (shared) =>
            Effect.tryPromise({
              try: async () => {
                activeRuntimes.delete(shared);
                await shared.runtime.dispose();
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.orDie,
              Effect.ensuring(
                shutdownDiagnostics.effect(
                  "runtime.onRelease",
                  shutdownResource(shared.runtime.sessionId),
                  (key.options.onRelease ?? Effect.void).pipe(Effect.orDie),
                ),
              ),
              Effect.ensuring(PubSub.shutdown(shared.events)),
              (work) =>
                shutdownDiagnostics.effect(
                  "runtime.release",
                  shutdownResource(shared.runtime.sessionId),
                  work,
                ),
            ),
        ),
    });

    // A permanent chat keeps an application lease on its runtime, so a second runtime for
    // the same Pi Session would write the same transcript and make by-ID lookups ambiguous
    // until quit. A caller that resolves another location joins the open runtime instead.
    const permanentChatRuntime = Effect.fn("CakeSessionRuntimes.permanentChatRuntime")(function* (
      options: CakeSessionRuntimeAcquireOptions,
    ) {
      const sessionId = options.runtime.sessionId;
      if (options.profile._tag !== "CakeChatSession" || sessionId === undefined) return options;
      const open = [...activeRuntimes].filter((shared) => shared.runtime.sessionId === sessionId);
      const requested = runtimeTarget(options);
      const existing = open[0];
      if (!existing || open.some((shared) => runtimeTarget(shared.acquireOptions) === requested))
        return options;
      yield* Effect.logError(
        "Permanent chat requested at a second location; reusing the open runtime",
        {
          sessionId,
          requested: { cwd: options.runtime.cwd, sessionDir: options.runtime.sessionDir },
          open: { cwd: existing.workingDirectory, sessionDir: existing.sessionDirectory },
        },
      );
      return existing.acquireOptions;
    });

    const acquire = Effect.fn("CakeSessionRuntimes.acquireLease")(function* (
      requested: CakeSessionRuntimeAcquireOptions,
    ) {
      yield* validateProfile(requested);
      const options = yield* permanentChatRuntime(requested);
      const key = new RuntimeKey(runtimeTarget(options), options);
      const ownerScope = yield* Effect.scope;
      const shared = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Retain through a private lease Scope until the options have been
          // checked. A rejected acquisition must not leave a reference in the
          // caller's longer-lived Scope.
          const leaseScope = yield* Scope.make();
          const retained = yield* restore(
            RcMap.get(runtimes, key).pipe(
              Effect.provideService(Scope.Scope, leaseScope),
              sessionError("acquire"),
            ),
          ).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(leaseScope, Exit.void) : Effect.void,
            ),
          );
          if (retained.fingerprint !== key.fingerprint) {
            yield* Scope.close(leaseScope, Exit.void);
            return yield* new PiSessionError({
              operation: "acquire",
              message: "That Pi Session is already acquired with conflicting runtime options",
            });
          }
          yield* Scope.addFinalizer(ownerScope, Scope.close(leaseScope, Exit.void));
          // The permanent coordinator belongs to the application, not its visible pane.
          // Keep one ordinary RcMap lease so worker reports can wake it after observers leave.
          if (retained.profile === "CakeChatSession" && !retained.applicationLease) {
            retained.applicationLease = true;
            yield* RcMap.get(runtimes, key).pipe(
              Effect.provideService(Scope.Scope, layerScope),
              sessionError("acquire"),
            );
          }
          return retained;
        }),
      );

      return {
        shared,
        options,
        retain: () => RcMap.get(runtimes, key),
      };
    });
    const currentRuntimes: ReadonlySet<SharedRuntime> = activeRuntimes;
    return { acquire, activeRuntimes: currentRuntimes };
  },
);
