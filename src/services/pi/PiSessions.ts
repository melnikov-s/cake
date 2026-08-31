import {
  Context,
  Effect,
  Equal,
  Hash,
  Layer,
  PubSub,
  RcMap,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
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
  | { readonly type: "snapshot-updated"; readonly snapshot: SessionSnapshot };

export type PiSessionUpdate =
  | { readonly _tag: "Snapshot"; readonly snapshot: SessionSnapshot }
  | { readonly _tag: "Event"; readonly event: PiSessionEvent };

/**
 * Runtime construction remains an adapter concern until Cake Session domain
 * operations replace the legacy drivers in Phase 6. The semantic profile is
 * mandatory here so callers cannot assemble Pi extension/tool policy ad hoc.
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
  ) => Effect.Effect<void, PiSessionError>;
  readonly steer: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
  ) => Effect.Effect<void, PiSessionError>;
  readonly followUp: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
  ) => Effect.Effect<void, PiSessionError>;
  readonly abort: () => Effect.Effect<void, PiSessionError>;
  readonly executeCommand: (
    command: string,
    arguments_: string,
  ) => Effect.Effect<string | undefined, PiSessionError>;
  readonly applyConfiguration: (
    configuration: ChatConfiguration,
  ) => Effect.Effect<void, PiSessionError>;
  readonly setModel: (provider: string, modelId: string) => Effect.Effect<void, PiSessionError>;
  readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void, PiSessionError>;
  readonly setPiSetting: (update: PiSettingUpdate) => Effect.Effect<void, PiSessionError>;
  readonly compact: (instructions?: string) => Effect.Effect<void, PiSessionError>;
  readonly fork: (
    entryId: string,
  ) => Effect.Effect<{ readonly sessionId: string; readonly sessionFile: string }, PiSessionError>;
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
  }
>()("cake/services/pi/PiSessions") {}

interface SharedRuntime {
  readonly fingerprint: string;
  readonly runtime: CakeRuntime;
  readonly events: PubSub.PubSub<PiSessionEvent>;
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
    newSession: runtime.newSession ?? false,
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
      // RcMap is the process-local keyed resource owner. Each acquire retains a
      // reference in its caller Scope; the final release disposes the one Pi
      // runtime. Equal/Hash intentionally key only by Pi Session target, while
      // the fingerprint below rejects conflicting runtime-defining options.
      const runtimes = yield* RcMap.make({
        lookup: (key: RuntimeKey) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const events = yield* PubSub.unbounded<PiSessionEvent>();
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
              return { fingerprint: key.fingerprint, runtime, events } satisfies SharedRuntime;
            }),
            ({ runtime, events }) =>
              Effect.sync(() => runtime.dispose()).pipe(Effect.andThen(PubSub.shutdown(events))),
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
        const shared = yield* RcMap.get(runtimes, key).pipe(sessionError("acquire"));
        if (shared.fingerprint !== key.fingerprint)
          return yield* new PiSessionError({
            operation: "acquire",
            message: "That Pi Session is already acquired with conflicting runtime options",
          });

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

        return {
          updates,
          snapshot: () => call("snapshot", (runtime) => runtime.snapshot()),
          prompt: (text, attachments = [], markdown = false) =>
            call("prompt", (runtime) => runtime.prompt(text, "prompt", [...attachments], markdown)),
          steer: (text, attachments = []) =>
            call("steer", (runtime) => runtime.prompt(text, "steer", [...attachments])),
          followUp: (text, attachments = []) =>
            call("followUp", (runtime) => runtime.prompt(text, "follow-up", [...attachments])),
          abort: () => call("abort", (runtime) => runtime.abort()),
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
          setModel: (provider, modelId) =>
            call("setModel", (runtime) => runtime.setModel(provider, modelId)),
          setThinkingLevel: (level) =>
            call("setThinkingLevel", (runtime) => runtime.setThinkingLevel(level)),
          setPiSetting: (update) => call("setPiSetting", (runtime) => runtime.setPiSetting(update)),
          compact: (instructions) => call("compact", (runtime) => runtime.compact(instructions)),
          fork: (entryId) => call("fork", (runtime) => runtime.fork(entryId)),
          reload: () =>
            shared.runtime.reload
              ? call("reload", (runtime) => runtime.reload?.() ?? Promise.resolve())
              : Effect.fail(
                  new PiSessionError({ operation: "reload", message: "Reload is unavailable" }),
                ),
        } satisfies PiSessionHandle;
      });

      return PiSessions.of({ list, inspect, acquire });
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
