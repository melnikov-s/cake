import {
  Context,
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  PubSub,
  RcMap,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { jsonValueSchema } from "../../ipc/json-contract";
import type {
  Attachment,
  ChatConfiguration,
  PiSettingUpdate,
  SessionPreview,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
} from "../../ipc/session-contract";
import {
  createCakeRuntime,
  type CakeRuntime,
  type CakeRuntimeEvent,
  type CakeRuntimeOptions,
} from "./runtime/cake-runtime";
import {
  listWorkspaceSessions,
  loadPiChangelog,
  loadWorkspaceSessionPreview,
} from "./runtime/session-discovery";
import type { ReviewParentContext } from "./runtime/sidecar-runtime";

const PiSessionCapabilityProfile = Schema.TaggedUnion({
  ProjectSession: {},
  CakeChatSession: {},
  DiscussionSession: {},
  SubagentSession: {
    profile: Schema.Literals(["scout", "planner", "reviewer", "worker"]),
  },
});
export const PiSessionQuery = Schema.Struct({
  workingDirectory: Schema.String,
  sessionDirectory: Schema.String,
  resolvedSessionDirectory: Schema.optionalKey(Schema.String),
  direct: Schema.optionalKey(Schema.Boolean),
});
export interface PiSessionQuery extends Schema.Schema.Type<typeof PiSessionQuery> {}

export const PiSessionTarget = Schema.Struct({
  workingDirectory: Schema.String,
  sessionId: Schema.String,
  sessionDirectory: Schema.String,
  resolvedSessionDirectory: Schema.optionalKey(Schema.String),
  direct: Schema.optionalKey(Schema.Boolean),
});
export interface PiSessionTarget extends Schema.Schema.Type<typeof PiSessionTarget> {}

export class PiSessionError extends Schema.TaggedError<PiSessionError>()("PiSessionError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type PiSessionEvent =
  | Exclude<CakeRuntimeEvent, { readonly type: "snapshot" }>
  | { readonly type: "snapshot-updated"; readonly snapshot: SessionSnapshot }
  | {
      readonly type: "turn-accepted";
      readonly sessionId: string;
      readonly turnId: string;
      readonly delivery: "prompt" | "steer" | "follow-up";
    }
  | {
      readonly type: "turn-settled";
      readonly sessionId: string;
      readonly turnId: string;
      readonly outcome: "complete" | "failed" | "aborted";
      readonly message?: string;
    };

export type PiSessionUpdate =
  | { readonly _tag: "Snapshot"; readonly snapshot: SessionSnapshot }
  | { readonly _tag: "Event"; readonly event: PiSessionEvent };

/**
 * Runtime construction is a Pi adapter concern. The semantic profile is
 * mandatory so callers cannot assemble Pi extension/tool policy ad hoc.
 */
export interface PiSessionAcquireOptions {
  readonly profile: Schema.Schema.Type<typeof PiSessionCapabilityProfile>;
  readonly runtime: Omit<CakeRuntimeOptions, "onEvent">;
}

export interface PiSessionHandle {
  readonly updates: Stream.Stream<PiSessionUpdate, PiSessionError>;
  readonly snapshot: () => Effect.Effect<SessionSnapshot, PiSessionError>;
  readonly prompt: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
    renderUserMessageAsMarkdown?: boolean,
  ) => Effect.Effect<string, PiSessionError>;
  readonly steer: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
  ) => Effect.Effect<string, PiSessionError>;
  readonly followUp: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
  ) => Effect.Effect<string, PiSessionError>;
  readonly editMessage: (
    entryId: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
    renderUserMessageAsMarkdown: boolean,
  ) => Effect.Effect<void, PiSessionError>;
  readonly abort: () => Effect.Effect<void, PiSessionError>;
  readonly executeCommand: (
    command: string,
    arguments_: string,
  ) => Effect.Effect<string | undefined, PiSessionError>;
  readonly applyConfiguration: (
    configuration: ChatConfiguration,
  ) => Effect.Effect<void, PiSessionError>;
  readonly configuration: () => Effect.Effect<ChatConfiguration | undefined, PiSessionError>;
  readonly setModel: (provider: string, modelId: string) => Effect.Effect<void, PiSessionError>;
  readonly setFastMode: (enabled: boolean) => Effect.Effect<void, PiSessionError>;
  readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void, PiSessionError>;
  readonly setPiSetting: (update: PiSettingUpdate) => Effect.Effect<void, PiSessionError>;
  readonly login: (
    provider: string,
    authType: "api_key" | "oauth",
  ) => Effect.Effect<void, PiSessionError>;
  readonly logout: (provider: string) => Effect.Effect<void, PiSessionError>;
  readonly navigate: (entryId: string) => Effect.Effect<void, PiSessionError>;
  readonly compact: (instructions?: string) => Effect.Effect<void, PiSessionError>;
  readonly rename: (name: string) => Effect.Effect<void, PiSessionError>;
  readonly fork: (
    entryId: string,
  ) => Effect.Effect<{ readonly sessionId: string; readonly sessionFile: string }, PiSessionError>;
  readonly handoff: (
    entryId: string,
  ) => Effect.Effect<{ readonly sessionId: string; readonly sessionFile: string }, PiSessionError>;
  readonly reviewParentContext: () => Effect.Effect<ReviewParentContext, PiSessionError>;
  readonly notifySubagentCompletion: (
    result: Schema.Schema.Type<typeof Schema.Json>,
  ) => Effect.Effect<void, PiSessionError>;
  readonly reload: () => Effect.Effect<void, PiSessionError>;
}

export interface PiSessionsAdapter {
  readonly list: (query: PiSessionQuery) => Effect.Effect<ReadonlyArray<SessionSummary>, unknown>;
  readonly inspect: (target: PiSessionTarget) => Effect.Effect<SessionPreview | undefined, unknown>;
  readonly createRuntime: (options: CakeRuntimeOptions) => Effect.Effect<CakeRuntime, unknown>;
  readonly changelog: () => Effect.Effect<string, unknown>;
}

export class PiSessions extends Context.Service<
  PiSessions,
  {
    readonly list: (
      query: PiSessionQuery,
    ) => Effect.Effect<ReadonlyArray<SessionSummary>, PiSessionError>;
    readonly inspect: (target: PiSessionTarget) => Effect.Effect<SessionPreview, PiSessionError>;
    readonly acquire: (
      options: PiSessionAcquireOptions,
    ) => Effect.Effect<PiSessionHandle, PiSessionError, Scope.Scope>;
    readonly refreshModels: () => Effect.Effect<void, PiSessionError>;
    readonly reloadCakeChatContext: () => Effect.Effect<void, PiSessionError>;
  }
>()("cake/services/pi/PiSessions") {}

interface SharedRuntime {
  readonly fingerprint: string;
  readonly profile: PiSessionAcquireOptions["profile"]["_tag"];
  readonly runtime: CakeRuntime;
  readonly events: PubSub.PubSub<PiSessionEvent>;
  readonly activeTurns: Ref.Ref<ReadonlyMap<string, "prompt" | "steer" | "follow-up">>;
}

class RuntimeKey implements Equal.Equal {
  readonly fingerprint: string;
  constructor(
    readonly target: string,
    readonly options: PiSessionAcquireOptions,
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

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const sessionError = (operation: string) =>
  Effect.mapError((cause: unknown) => new PiSessionError({ operation, message: messageOf(cause) }));

const runtimeTarget = (options: PiSessionAcquireOptions): string => {
  const runtime = options.runtime;
  const identity =
    runtime.sessionId ?? runtime.sessionFile ?? (runtime.newSession ? "new" : "recent");
  return `${runtime.cwd}\u0000${runtime.sessionDir}\u0000${identity}`;
};

const runtimeFingerprint = (options: PiSessionAcquireOptions): string => {
  const runtime = options.runtime;
  return JSON.stringify({
    profile: options.profile,
    cwd: runtime.cwd,
    agentDir: runtime.agentDir,
    sessionDir: runtime.sessionDir,
    resolvedSessionDir: runtime.resolvedSessionDir,
    // Once a caller creates an explicit session ID, later open/command
    // acquisitions address that same runtime. Creation mode is not a lasting
    // runtime policy and therefore is not part of the conflict fingerprint.
    sessionId: runtime.sessionId,
    sessionFile: runtime.sessionFile,
    trusted: runtime.trusted,
    tools: runtime.tools ? [...runtime.tools].sort() : undefined,
    auxiliary: runtime.auxiliary ?? false,
    slashCommands: runtime.slashCommands,
    pluginResources: runtime.pluginResources,
    additionalSystemPrompt: runtime.additionalSystemPrompt,
    hasGlobalControl: runtime.globalControl !== undefined,
    hasAgentControl: runtime.agentControl !== undefined,
  });
};

const validateProfile = Effect.fn("PiSessions.validateProfile")(function* (
  options: PiSessionAcquireOptions,
) {
  const decoded = yield* Schema.decodeUnknownEffect(PiSessionCapabilityProfile)(
    options.profile,
  ).pipe(sessionError("acquire"));
  const profile = decoded._tag;
  const runtime = options.runtime;
  const valid =
    (profile === "ProjectSession" && !runtime.auxiliary && !runtime.globalControl) ||
    (profile === "CakeChatSession" && runtime.globalControl !== undefined && !runtime.auxiliary) ||
    ((profile === "DiscussionSession" || profile === "SubagentSession") &&
      runtime.auxiliary === true &&
      runtime.globalControl === undefined);
  if (valid) return;
  return yield* new PiSessionError({
    operation: "acquire",
    message: `Runtime options conflict with the ${profile} capability profile`,
  });
});

const runtimeOperation = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(sessionError(operation));

export const makePiSessionsLayer = (adapter: PiSessionsAdapter) =>
  Layer.effect(
    PiSessions,
    Effect.gen(function* () {
      const layerScope = yield* Effect.scope;
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
              const events = yield* PubSub.unbounded<PiSessionEvent>();
              const activeTurns = yield* Ref.make<
                ReadonlyMap<string, "prompt" | "steer" | "follow-up">
              >(new Map());
              const runtime = yield* adapter.createRuntime({
                ...key.options.runtime,
                onEvent(event) {
                  const projected: PiSessionEvent =
                    event.type === "snapshot"
                      ? { type: "snapshot-updated", snapshot: event.snapshot }
                      : event;
                  PubSub.publishUnsafe(events, projected);
                },
              });
              const shared = {
                fingerprint: key.fingerprint,
                profile: key.options.profile._tag,
                runtime,
                events,
                activeTurns,
              } satisfies SharedRuntime;
              activeRuntimes.add(shared);
              return shared;
            }),
            (shared) =>
              Effect.tryPromise({
                try: async () => {
                  activeRuntimes.delete(shared);
                  await shared.runtime.dispose();
                },
                catch: (cause) => cause,
              }).pipe(Effect.orDie, Effect.ensuring(PubSub.shutdown(shared.events))),
          ),
      });

      const list = Effect.fn("PiSessions.list")(function* (query: PiSessionQuery) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionQuery)(query).pipe(
          sessionError("list"),
        );
        return yield* adapter.list(decoded).pipe(sessionError("list"));
      });

      const inspect = Effect.fn("PiSessions.inspect")(function* (target: PiSessionTarget) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionTarget)(target).pipe(
          sessionError("inspect"),
        );
        const preview = yield* adapter.inspect(decoded).pipe(sessionError("inspect"));
        if (preview) return preview;
        return yield* new PiSessionError({
          operation: "inspect",
          message: `Pi Session ${decoded.sessionId} was not found`,
        });
      });

      const acquire = Effect.fn("PiSessions.acquire")(function* (options: PiSessionAcquireOptions) {
        yield* validateProfile(options);
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
            return retained;
          }),
        );

        const call = <A>(operation: string, evaluate: (runtime: CakeRuntime) => Promise<A>) =>
          runtimeOperation(operation, () => evaluate(shared.runtime));
        const updates = Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the snapshot. Runtime events produced
            // while Pi builds the snapshot are buffered by this subscription,
            // eliminating the initial snapshot/live-event gap.
            const subscription = yield* PubSub.subscribe(shared.events);
            const snapshot = yield* call("observe", (runtime) => runtime.snapshot());
            return Stream.make({ _tag: "Snapshot" as const, snapshot }).pipe(
              Stream.concat(
                Stream.fromEffect(PubSub.take(subscription)).pipe(
                  Stream.repeat(Schedule.forever),
                  Stream.map((event): PiSessionUpdate => ({ _tag: "Event", event })),
                ),
              ),
            );
          }),
        );

        const startTurn = Effect.fn("PiSessions.startTurn")(function* (
          delivery: "prompt" | "steer" | "follow-up",
          text: string,
          attachments: ReadonlyArray<Attachment>,
          markdown = false,
        ) {
          const turnId = crypto.randomUUID();
          const turnScope = yield* Scope.make();
          const retained = yield* RcMap.get(runtimes, key).pipe(
            Effect.provideService(Scope.Scope, turnScope),
            sessionError(delivery),
          );
          yield* Ref.update(retained.activeTurns, (turns) => new Map(turns).set(turnId, delivery));
          yield* PubSub.publish(retained.events, {
            type: "turn-accepted",
            sessionId: retained.runtime.sessionId,
            turnId,
            delivery,
          });
          const settle = Effect.fn("PiSessions.settleTurn")(function* (
            outcome: "complete" | "failed",
            message?: string,
          ) {
            const active = yield* Ref.modify(retained.activeTurns, (turns) => {
              if (!turns.has(turnId)) return [false, turns] as const;
              const next = new Map(turns);
              next.delete(turnId);
              return [true, next] as const;
            });
            if (active) {
              const event: PiSessionEvent = {
                type: "turn-settled",
                sessionId: retained.runtime.sessionId,
                turnId,
                outcome,
              };
              if (message !== undefined) Object.assign(event, { message });
              yield* PubSub.publish(retained.events, event);
            }
          });
          const run = runtimeOperation(delivery, () =>
            retained.runtime.prompt(text, delivery, [...attachments], markdown),
          ).pipe(
            Effect.matchEffect({
              onSuccess: () => settle("complete"),
              onFailure: (error) => settle("failed", error.message),
            }),
            Effect.ensuring(Scope.close(turnScope, Exit.void)),
          );
          yield* run.pipe(Effect.forkIn(layerScope));
          return turnId;
        });

        return {
          updates,
          snapshot: () => call("snapshot", (runtime) => runtime.snapshot()),
          prompt: (text, attachments = [], markdown = false) =>
            startTurn("prompt", text, attachments, markdown),
          steer: (text, attachments = []) => startTurn("steer", text, attachments),
          followUp: (text, attachments = []) => startTurn("follow-up", text, attachments),
          editMessage: (entryId, text, attachments, renderUserMessageAsMarkdown) =>
            shared.runtime.editMessage
              ? call(
                  "editMessage",
                  (runtime) =>
                    runtime.editMessage?.(
                      entryId,
                      text,
                      [...attachments],
                      renderUserMessageAsMarkdown,
                    ) ?? Promise.resolve(),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "editMessage",
                    message: "Message editing is unavailable",
                  }),
                ),
          abort: Effect.fn("PiSessions.abort")(function* () {
            const active = yield* Ref.getAndSet(shared.activeTurns, new Map());
            yield* call("abort", (runtime) => runtime.abort());
            yield* Effect.forEach(
              active,
              ([turnId]) =>
                PubSub.publish(shared.events, {
                  type: "turn-settled",
                  sessionId: shared.runtime.sessionId,
                  turnId,
                  outcome: "aborted",
                }),
              { discard: true },
            );
          }),
          executeCommand: (command, arguments_) =>
            command === "changelog"
              ? adapter.changelog().pipe(
                  sessionError("executeCommand"),
                  Effect.map((text) => text),
                )
              : call("executeCommand", (runtime) =>
                  runtime
                    .prompt(
                      `/${command}${arguments_.trim() ? ` ${arguments_.trim()}` : ""}`,
                      "prompt",
                      [],
                    )
                    .then(() => undefined),
                ),
          applyConfiguration: (configuration) =>
            call("applyConfiguration", (runtime) => runtime.applyConfiguration(configuration)),
          configuration: () =>
            Effect.try({
              try: () => shared.runtime.currentConfiguration?.(),
              catch: (cause) => cause,
            }).pipe(sessionError("configuration")),
          setModel: (provider, modelId) =>
            call("setModel", (runtime) => runtime.setModel(provider, modelId)),
          setFastMode: (enabled) =>
            shared.runtime.setFastMode
              ? call(
                  "setFastMode",
                  (runtime) => runtime.setFastMode?.(enabled) ?? Promise.resolve(),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "setFastMode",
                    message: "Fast mode is unavailable",
                  }),
                ),
          setThinkingLevel: (level) =>
            call("setThinkingLevel", (runtime) => runtime.setThinkingLevel(level)),
          setPiSetting: (update) => call("setPiSetting", (runtime) => runtime.setPiSetting(update)),
          login: (provider, authType) =>
            call("login", (runtime) => runtime.login(provider, authType)),
          logout: (provider) => call("logout", (runtime) => runtime.logout(provider)),
          navigate: (entryId) => call("navigate", (runtime) => runtime.navigate(entryId)),
          compact: (instructions) => call("compact", (runtime) => runtime.compact(instructions)),
          rename: (name) => call("rename", (runtime) => runtime.rename(name)),
          fork: (entryId) => call("fork", (runtime) => runtime.fork(entryId)),
          handoff: (entryId) => call("handoff", (runtime) => runtime.handoff(entryId)),
          reviewParentContext: () =>
            Effect.try({
              try: () => shared.runtime.getReviewParentContext?.(),
              catch: (cause) => cause,
            }).pipe(
              sessionError("reviewParentContext"),
              Effect.flatMap((context) =>
                context
                  ? Effect.succeed(context)
                  : Effect.fail(
                      new PiSessionError({
                        operation: "reviewParentContext",
                        message: "The parent session context is unavailable",
                      }),
                    ),
              ),
            ),
          notifySubagentCompletion: (result) =>
            shared.runtime.notifySubagentCompletion
              ? call(
                  "notifySubagentCompletion",
                  (runtime) =>
                    runtime.notifySubagentCompletion?.(
                      Schema.decodeUnknownSync(jsonValueSchema)(result),
                    ) ?? Promise.resolve(),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "notifySubagentCompletion",
                    message: "Subagent completion delivery is unavailable",
                  }),
                ),
          reload: () =>
            shared.runtime.reload
              ? call("reload", (runtime) => runtime.reload?.() ?? Promise.resolve())
              : Effect.fail(
                  new PiSessionError({ operation: "reload", message: "Reload is unavailable" }),
                ),
        } satisfies PiSessionHandle;
      });

      const refreshModels = Effect.fn("PiSessions.refreshModels")(function* () {
        yield* Effect.forEach(
          activeRuntimes,
          (shared) => {
            const refresh = shared.runtime.refreshModels;
            return refresh
              ? runtimeOperation("refreshModels", () => refresh.call(shared.runtime))
              : Effect.void;
          },
          { concurrency: "unbounded", discard: true },
        );
      });
      const reloadCakeChatContext = Effect.fn("PiSessions.reloadCakeChatContext")(function* () {
        yield* Effect.forEach(
          [...activeRuntimes].filter((shared) => shared.profile === "CakeChatSession"),
          (shared) => {
            const reload = shared.runtime.reload;
            return reload
              ? runtimeOperation("reloadCakeChatContext", () => reload.call(shared.runtime))
              : Effect.void;
          },
          { concurrency: "unbounded", discard: true },
        );
      });

      return PiSessions.of({ list, inspect, acquire, refreshModels, reloadCakeChatContext });
    }),
  );

export const makePiSessionsLive = (): Layer.Layer<PiSessions> =>
  makePiSessionsLayer({
    list: (query) =>
      Effect.tryPromise({
        try: () =>
          listWorkspaceSessions(query.workingDirectory, query.sessionDirectory, {
            direct: query.direct,
            resolvedSessionDir: query.resolvedSessionDirectory,
          }),
        catch: (cause) => cause,
      }),
    inspect: (target) =>
      Effect.tryPromise({
        try: () =>
          loadWorkspaceSessionPreview(
            target.workingDirectory,
            target.sessionId,
            target.sessionDirectory,
            target.resolvedSessionDirectory,
            target.direct,
          ),
        catch: (cause) => cause,
      }),
    createRuntime: (options) =>
      Effect.tryPromise({ try: () => createCakeRuntime(options), catch: (cause) => cause }),
    changelog: () => Effect.sync(loadPiChangelog),
  });
