import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Option,
  RcMap,
  Ref,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { SessionSnapshot, UtilityModel } from "../ipc/session-contract";
import { getState } from "./application";
import {
  ParallelSubagentInput,
  SubagentError,
  SubagentHandleId,
  SubagentTaskInput,
  type AgentModelPreference,
  type ResolvedAgentModel,
  type SubagentActivity,
  type SubagentResult,
  type SubagentStartReceipt,
  type SubagentTask,
  type SubagentUpdate,
} from "./subagent-data";
import {
  PiSessionError,
  PiSessions,
  type PiSessionAcquireOptions,
} from "../services/pi/PiSessions";
import {
  SubagentCoordinator,
  activityOf,
  removeHandle,
  updateHandle,
  type SubagentCoordinatorState,
  type SubagentHandleState,
} from "../services/subagents/SubagentCoordinator";
import {
  SubagentEnvironment,
  SubagentEnvironmentError,
} from "../services/subagents/SubagentEnvironment";

export * from "./subagent-data";

const MAX_HANDLES_PER_PARENT = 8;
const MAX_PRIVATE_RUNTIMES_PER_WORKING_DIRECTORY = 32;
const RESULT_RETENTION = "5 minutes";
const WAIT_TIMEOUT = "5 minutes";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "cake"]);
const AUXILIARY_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "cake"]);

const PROFILE_INSTRUCTIONS = {
  scout: "Explore the codebase and report concise, evidence-backed findings. Do not modify files.",
  planner:
    "Analyze the requested work and return an implementation plan with relevant files, dependencies, risks, and verification. Do not modify files.",
  reviewer:
    "Review the requested code for correctness, security, and maintainability. Report concrete findings with file and line references. Do not modify files.",
  worker:
    "Complete the bounded implementation task, verify the result, and summarize changed files and checks. Do not delegate unless the caller explicitly granted delegation depth.",
} as const;

export interface SubagentParentRuntime {
  readonly parentSessionId: string;
  readonly workingDirectory: string;
  readonly remainingDepth: number;
  readonly options: PiSessionAcquireOptions;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const asError = (operation: string) =>
  Effect.mapError((error: PiSessionError | SubagentEnvironmentError | SubagentError | unknown) =>
    error instanceof SubagentError
      ? error
      : new SubagentError({
          operation,
          message:
            error instanceof PiSessionError || error instanceof SubagentEnvironmentError
              ? error.message
              : messageOf(error),
        }),
  );

const jsonValue = <A>(value: A): Schema.Schema.Type<typeof Schema.Json> =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));
const projectParts = (parts: SessionSnapshot["parts"]) => parts.slice(-10_000).map(jsonValue);
const boundedError = (message: string) => message.slice(0, 16_384);

const normalizeTask = Effect.fn("Subagents.normalizeTask")(function* (input: SubagentTaskInput) {
  const decoded = yield* Schema.decodeUnknownEffect(SubagentTaskInput)(input).pipe(
    Effect.mapError(
      (error) => new SubagentError({ operation: "preflight", message: error.message }),
    ),
  );
  const task: SubagentTask = {
    task: decoded.task,
    profile: decoded.profile ?? "worker",
    model: decoded.model ?? { prefer: "current" },
    fastMode: decoded.fastMode ?? false,
    maxDepth: decoded.maxDepth ?? 0,
    retain: decoded.retain ?? false,
  };
  if (decoded.instructions !== undefined)
    Object.assign(task, { instructions: decoded.instructions });
  return task;
});

const toolsForProfile = (profile: SubagentTask["profile"], parentTools: readonly string[]) => {
  const nonDelegating = parentTools.filter((name) => AUXILIARY_TOOLS.has(name));
  return profile === "worker"
    ? nonDelegating
    : nonDelegating.filter((name) => READ_ONLY_TOOLS.has(name));
};

const systemPrompt = (task: SubagentTask) => {
  const profile = `## Subagent role: ${task.profile}\n\n${PROFILE_INSTRUCTIONS[task.profile]}`;
  return task.instructions
    ? `${profile}\n\n## Additional instructions\n\n${task.instructions}`
    : profile;
};

const fallbackReason = (snapshot: SessionSnapshot, provider: string, modelId: string) => {
  const model = snapshot.models.find((item) => item.provider === provider && item.id === modelId);
  if (!model) return "unknown-model" as const;
  if (!model.authenticated) return "not-authenticated" as const;
  return undefined;
};

const resolveModel = (
  preference: AgentModelPreference,
  snapshot: SessionSnapshot,
  utility: UtilityModel | undefined,
): ResolvedAgentModel => {
  const fallbacks: Array<ResolvedAgentModel["fallbacks"][number]> = [];
  const accept = (
    source: ResolvedAgentModel["source"],
    provider: string | undefined,
    modelId: string | undefined,
    thinkingLevel: ResolvedAgentModel["thinkingLevel"] | undefined,
  ) => {
    if (!provider || !modelId) {
      if (source !== "exact") fallbacks.push({ source, reason: "not-configured" });
      return undefined;
    }
    const reason = fallbackReason(snapshot, provider, modelId);
    if (reason) {
      if (source === "exact")
        throw new SubagentError({
          operation: "preflight",
          message: `Requested model ${provider}/${modelId} is ${reason === "unknown-model" ? "unknown" : "not authenticated"}`,
        });
      fallbacks.push({ source, reason });
      return undefined;
    }
    return {
      requested: preference.prefer,
      source,
      provider,
      modelId,
      thinkingLevel: thinkingLevel ?? "medium",
      fallbacks,
    } satisfies ResolvedAgentModel;
  };
  if (preference.prefer === "exact") {
    const resolved = accept(
      "exact",
      preference.provider,
      preference.modelId,
      preference.thinkingLevel ?? snapshot.thinkingLevel,
    );
    if (resolved) return resolved;
    throw new SubagentError({
      operation: "preflight",
      message: "The exact model selection is incomplete",
    });
  }
  if (preference.prefer === "utility") {
    const resolved = accept("utility", utility?.provider, utility?.modelId, utility?.thinkingLevel);
    if (resolved) return resolved;
  }
  if (preference.prefer === "utility" || preference.prefer === "default") {
    const resolved = accept(
      "default",
      snapshot.piSettings?.defaultProvider,
      snapshot.piSettings?.defaultModel,
      snapshot.piSettings?.defaultThinkingLevel,
    );
    if (resolved) return resolved;
  }
  const current =
    snapshot.model &&
    accept("current", snapshot.model.provider, snapshot.model.id, snapshot.thinkingLevel);
  if (current) return current;
  throw new SubagentError({
    operation: "preflight",
    message: "The calling session has no available current model",
  });
};

interface PreparedTask {
  readonly input: SubagentTask;
  readonly parent: SubagentParentRuntime;
  readonly resolvedModel: ResolvedAgentModel;
  readonly tools: ReadonlyArray<string>;
  readonly remainingDepth: number;
}

const prepareTasks = Effect.fn("Subagents.prepareTasks")(function* (
  inputs: ReadonlyArray<SubagentTaskInput>,
  parent: SubagentParentRuntime,
) {
  const tasks = yield* Effect.forEach(inputs, normalizeTask);
  const sessions = yield* PiSessions;
  const coordinator = yield* SubagentCoordinator;
  const application = yield* getState();
  const current = yield* SubscriptionRef.get(coordinator.state);
  const privateParent = [...current.handles.values()].find(
    (handle) => handle.privateSessionId === parent.parentSessionId,
  );
  const effectiveParent: SubagentParentRuntime = privateParent
    ? {
        parentSessionId: parent.parentSessionId,
        workingDirectory: privateParent.workingDirectory,
        remainingDepth: Math.max(0, privateParent.remainingDepth - 1),
        options: privateParent.runtimeOptions,
      }
    : parent;
  const { snapshot, parentTools } = yield* Effect.scoped(
    Effect.gen(function* () {
      const parentHandle = yield* sessions
        .acquire(effectiveParent.options)
        .pipe(asError("preflight"));
      const snapshot = yield* parentHandle.snapshot().pipe(asError("preflight"));
      const parentTools = yield* parentHandle.reviewParentContext().pipe(
        Effect.map((context) => context.activeTools ?? []),
        Effect.catchTag("PiSessionError", () =>
          Effect.succeed(["read", "bash", "edit", "write", "grep", "find", "ls", "cake"]),
        ),
      );
      return { snapshot, parentTools };
    }),
  );
  const owned = [...current.handles.values()].filter(
    (handle) => handle.parentSessionId === effectiveParent.parentSessionId,
  ).length;
  if (owned + tasks.length > MAX_HANDLES_PER_PARENT)
    return yield* new SubagentError({
      operation: "preflight",
      message: `An agent may own at most ${MAX_HANDLES_PER_PARENT} subagent handles. Close an unused subagent before starting another.`,
    });
  const liveInDirectory = [...current.handles.values()].filter(
    (handle) =>
      handle.workingDirectory === effectiveParent.workingDirectory && handle.piHandle !== undefined,
  ).length;
  if (liveInDirectory + tasks.length > MAX_PRIVATE_RUNTIMES_PER_WORKING_DIRECTORY)
    return yield* new SubagentError({
      operation: "preflight",
      message: `This Working Directory already has too many live private agent runtimes.`,
    });
  return yield* Effect.try({
    try: () =>
      tasks.map((input): PreparedTask => {
        const resolvedModel = resolveModel(input.model, snapshot, application.utilityModel);
        const selected = snapshot.models.find(
          (model) =>
            model.provider === resolvedModel.provider && model.id === resolvedModel.modelId,
        );
        if (input.fastMode && !selected?.fastMode)
          throw new SubagentError({
            operation: "preflight",
            message: `Fast mode is unavailable for ${resolvedModel.provider}/${resolvedModel.modelId}`,
          });
        return {
          input,
          parent: effectiveParent,
          resolvedModel,
          tools: toolsForProfile(input.profile, parentTools),
          remainingDepth: Math.min(input.maxDepth, Math.max(0, effectiveParent.remainingDepth)),
        };
      }),
    catch: (cause) =>
      cause instanceof SubagentError
        ? cause
        : new SubagentError({ operation: "preflight", message: messageOf(cause) }),
  });
});

const mutateHandle = Effect.fn("Subagents.mutateHandle")(function* (
  handleId: SubagentHandleId,
  update: (handle: SubagentHandleState) => SubagentHandleState,
) {
  const coordinator = yield* SubagentCoordinator;
  yield* SubscriptionRef.update(coordinator.state, (state) =>
    updateHandle(state, handleId, (handle) => {
      const next = update(handle);
      return next === handle ? handle : { ...next, activityRevision: handle.activityRevision + 1 };
    }),
  );
});

const requireHandle = Effect.fn("Subagents.requireHandle")(function* (
  parentSessionId: string,
  handleId: string,
) {
  const decoded = yield* Schema.decodeUnknownEffect(SubagentHandleId)(handleId).pipe(
    Effect.mapError(
      () => new SubagentError({ operation: "handle", message: "That subagent handle is invalid" }),
    ),
  );
  const coordinator = yield* SubagentCoordinator;
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(decoded);
  if (!handle || handle.parentSessionId !== parentSessionId)
    return yield* new SubagentError({
      operation: "handle",
      message: "That subagent handle does not belong to this parent session",
    });
  return handle;
});

const snapshotResult = (
  handle: SubagentHandleState,
  snapshot: SessionSnapshot,
  status: SubagentResult["status"],
  error?: string,
): SubagentResult => {
  const result: SubagentResult = {
    handleId: handle.handleId,
    task: handle.task,
    profile: handle.profile,
    status,
    resolvedModel: handle.resolvedModel,
    fastMode: handle.fastMode,
    streaming: snapshot.streaming,
    parts: projectParts(snapshot.parts),
  };
  if (snapshot.usage !== undefined) Object.assign(result, { usage: jsonValue(snapshot.usage) });
  if (error !== undefined) Object.assign(result, { error: boundedError(error) });
  return result;
};

const completeHandle = Effect.fn("Subagents.completeHandle")(function* (
  handleId: SubagentHandleId,
  result: SubagentResult,
) {
  const coordinator = yield* SubagentCoordinator;
  const shouldNotify = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.handles.get(handleId);
    if (!current || current.result) return [false, state] as const;
    const notify = current.notifyOnCompletion && current.waiters === 0;
    const next: SubagentHandleState = {
      ...current,
      status: result.status,
      streaming: result.streaming,
      parts: result.parts,
      usage: result.usage,
      error: result.error,
      result,
      completionDisposition: current.notifyOnCompletion
        ? notify
          ? "notifying"
          : "waited"
        : "waited",
      activityRevision: current.activityRevision + 1,
    };
    return [notify, updateHandle(state, handleId, () => next)] as const;
  });
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
  if (!handle) return;
  yield* Deferred.succeed(handle.completion, result);
  if (shouldNotify) yield* deliverCompletion(handleId);
});

const deliverCompletion = Effect.fn("Subagents.deliverCompletion")(function* (
  handleId: SubagentHandleId,
) {
  const handle = yield* requireHandleById(handleId);
  if (!handle.result || handle.completionDisposition !== "notifying") return;
  const delivered = handle.parentPiHandle
    ? handle.parentPiHandle.notifySubagentCompletion(handle.result).pipe(
        asError("completion"),
        Effect.catchTag("SubagentError", () => Effect.void),
      )
    : Effect.void;
  yield* delivered;
  yield* mutateHandle(handleId, (current) =>
    current.completionDisposition === "notifying"
      ? { ...current, completionDisposition: "notified" }
      : current,
  );
});

const requireHandleById = Effect.fn("Subagents.requireHandleById")(function* (
  handleId: SubagentHandleId,
) {
  const coordinator = yield* SubagentCoordinator;
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
  if (!handle)
    return yield* new SubagentError({ operation: "handle", message: "That subagent is closed" });
  return handle;
});

const observeTurn = Effect.fn("Subagents.observeTurn")(function* (
  handleId: SubagentHandleId,
  delivery: "prompt" | "steer" | "follow-up",
  text: string,
) {
  const handle = yield* requireHandleById(handleId);
  const piHandle = handle.piHandle;
  if (!piHandle)
    return yield* new SubagentError({
      operation: delivery,
      message: "The retained subagent is still starting",
    });
  const ready = yield* Deferred.make<void>();
  const settled = yield* Ref.make<ReadonlyMap<string, { outcome: string; message?: string }>>(
    new Map(),
  );
  const target = yield* Ref.make<Option.Option<string>>(Option.none());
  const targetSettled = yield* Deferred.make<{ outcome: string; message?: string }>();
  const consume = piHandle.updates.pipe(
    Stream.runForEach((update) =>
      Effect.gen(function* () {
        if (update._tag === "Snapshot") {
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            privateSessionId: update.snapshot.sessionId,
            streaming: update.snapshot.streaming,
            parts: projectParts(update.snapshot.parts),
            usage:
              update.snapshot.usage === undefined
                ? current.usage
                : jsonValue(update.snapshot.usage),
          }));
          yield* Deferred.succeed(ready, undefined);
          return;
        }
        const event = update.event;
        if (event.type === "snapshot-updated")
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            streaming: event.snapshot.streaming,
            parts: projectParts(event.snapshot.parts),
            usage:
              event.snapshot.usage === undefined ? current.usage : jsonValue(event.snapshot.usage),
          }));
        else if (event.type === "part-updated")
          yield* mutateHandle(handleId, (current) => {
            const partIdentity = Schema.Struct({ id: Schema.String });
            const byId = new Map(
              current.parts.flatMap((part) => {
                const decoded = Schema.decodeUnknownOption(partIdentity)(part);
                return Option.isSome(decoded) ? [[decoded.value.id, part] as const] : [];
              }),
            );
            byId.set(event.part.id, jsonValue(event.part));
            return { ...current, parts: [...byId.values()].slice(-10_000) };
          });
        else if (event.type === "part-removed")
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            parts: current.parts.filter((part) => {
              const decoded = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(
                part,
              );
              return Option.isNone(decoded) || decoded.value.id !== event.partId;
            }),
          }));
        else if (event.type === "streaming")
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            streaming: event.streaming,
          }));
        else if (event.type === "turn-settled") {
          const settlement: { outcome: string; message?: string } =
            event.message === undefined
              ? { outcome: event.outcome }
              : { outcome: event.outcome, message: event.message };
          yield* Ref.update(settled, (values) => new Map(values).set(event.turnId, settlement));
          const currentTarget = yield* Ref.get(target);
          if (Option.isSome(currentTarget) && currentTarget.value === event.turnId)
            yield* Deferred.succeed(targetSettled, settlement);
        }
      }),
    ),
  );
  const observer = yield* consume.pipe(Effect.forkChild);
  yield* Deferred.await(ready).pipe(Effect.timeout(WAIT_TIMEOUT), asError(delivery));
  const turnId = yield* (
    delivery === "prompt"
      ? piHandle.prompt(text)
      : delivery === "steer"
        ? piHandle.steer(text)
        : piHandle.followUp(text)
  ).pipe(asError(delivery));
  yield* Ref.set(target, Option.some(turnId));
  const already = (yield* Ref.get(settled)).get(turnId);
  const settlement = already
    ? already
    : yield* Deferred.await(targetSettled).pipe(Effect.timeout(WAIT_TIMEOUT), asError(delivery));
  yield* Fiber.interrupt(observer);
  const finalSnapshot = yield* piHandle.snapshot().pipe(asError(delivery));
  const current = yield* requireHandleById(handleId);
  const status =
    settlement.outcome === "complete"
      ? "complete"
      : settlement.outcome === "aborted"
        ? "aborted"
        : "error";
  return snapshotResult(current, finalSnapshot, status, settlement.message);
});

const abortDirectChildren = Effect.fn("Subagents.abortDirectChildren")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  const children = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) =>
      handle.parentSessionId === parentSessionId &&
      (handle.status === "queued" || handle.status === "running"),
  );
  yield* Effect.forEach(
    children,
    (child) =>
      mutateHandle(child.handleId, (current) => ({
        ...current,
        status: "aborted",
        streaming: false,
      })).pipe(
        Effect.andThen(
          child.piHandle
            ? child.piHandle.abort().pipe(asError("abort"), Effect.asVoid)
            : FiberMap.remove(coordinator.fibers, child.handleId),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );
});

const releaseDirectChildren = Effect.fn("Subagents.releaseDirectChildren")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  const children = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) => handle.parentSessionId === parentSessionId,
  );
  yield* Effect.forEach(
    children,
    (child) =>
      SubscriptionRef.update(coordinator.state, (state) =>
        removeHandle(state, child.handleId),
      ).pipe(
        Effect.andThen(FiberMap.remove(coordinator.fibers, child.handleId)),
        Effect.andThen(Scope.close(child.scope, Exit.void)),
      ),
    { concurrency: "unbounded", discard: true },
  );
});

const executeInitial = Effect.fn("Subagents.executeInitial")(function* (
  handleId: SubagentHandleId,
  prepared: PreparedTask,
) {
  const coordinator = yield* SubagentCoordinator;
  const handle = yield* requireHandleById(handleId);
  const slot = yield* RcMap.get(coordinator.slots, prepared.parent.workingDirectory).pipe(
    Effect.provideService(Scope.Scope, handle.scope),
  );
  yield* slot.withPermit(
    Effect.gen(function* () {
      yield* mutateHandle(handleId, (current) => ({ ...current, status: "running" }));
      const current = yield* requireHandleById(handleId);
      const sessions = yield* PiSessions;
      const piHandle = yield* sessions
        .acquire(current.runtimeOptions)
        .pipe(Effect.provideService(Scope.Scope, current.scope), asError("start"));
      yield* mutateHandle(handleId, (value) => ({ ...value, piHandle }));
      const initial = yield* piHandle.snapshot().pipe(asError("start"));
      yield* mutateHandle(handleId, (value) => ({
        ...value,
        privateSessionId: initial.sessionId,
        streaming: initial.streaming,
        parts: projectParts(initial.parts),
      }));
      const selected =
        initial.model?.provider === prepared.resolvedModel.provider &&
        initial.model.id === prepared.resolvedModel.modelId &&
        initial.thinkingLevel === prepared.resolvedModel.thinkingLevel;
      if (!selected) {
        yield* piHandle
          .setModel(prepared.resolvedModel.provider, prepared.resolvedModel.modelId)
          .pipe(asError("start"));
        yield* piHandle
          .setThinkingLevel(prepared.resolvedModel.thinkingLevel)
          .pipe(asError("start"));
      }
      if (prepared.input.fastMode) yield* piHandle.setFastMode(true).pipe(asError("start"));
      const result = yield* observeTurn(handleId, "prompt", prepared.input.task);
      yield* completeHandle(handleId, result);
    }),
  );
});

const failHandle = Effect.fn("Subagents.failHandle")(function* (
  handleId: SubagentHandleId,
  cause: Cause.Cause<unknown>,
) {
  const handle = yield* requireHandleById(handleId).pipe(
    Effect.catchTag("SubagentError", () => Effect.succeed(undefined)),
  );
  if (!handle || handle.result) return;
  const aborted = Cause.hasInterrupts(cause) || handle.status === "aborted";
  const result: SubagentResult = {
    handleId: handle.handleId,
    task: handle.task,
    profile: handle.profile,
    status: aborted ? "aborted" : "error",
    resolvedModel: handle.resolvedModel,
    fastMode: handle.fastMode,
    streaming: false,
    parts: handle.parts,
    error: boundedError(aborted ? "Subagent aborted" : Cause.pretty(cause)),
  };
  yield* completeHandle(handleId, result);
});

const startPrepared = Effect.fn("Subagents.startPrepared")(function* (
  prepared: PreparedTask,
  anchorPartId: string,
  notifyOnCompletion: boolean,
) {
  const coordinator = yield* SubagentCoordinator;
  const environment = yield* SubagentEnvironment;
  const sessions = yield* PiSessions;
  const location = yield* environment
    .location(prepared.parent.workingDirectory)
    .pipe(asError("start"));
  const handleId = SubagentHandleId.make(crypto.randomUUID());
  const scope = yield* Scope.make();
  return yield* Effect.gen(function* () {
    const completion = yield* Deferred.make<SubagentResult, SubagentError>();
    const parentHandle = yield* sessions
      .acquire(prepared.parent.options)
      .pipe(Effect.provideService(Scope.Scope, scope), asError("start"));
    const agentControl =
      prepared.remainingDepth === 0 ? undefined : prepared.parent.options.runtime.agentControl;
    const runtimeOptions: PiSessionAcquireOptions = {
      profile: { _tag: "SubagentSession", profile: prepared.input.profile },
      runtime: {
        cwd: location.workingDirectory,
        trusted: location.trusted,
        agentDir: location.agentDirectory,
        sessionDir: location.sessionDirectory,
        newSession: true,
        sessionId: crypto.randomUUID(),
        auxiliary: true,
        tools: [...prepared.tools],
        slashCommands: [],
        additionalSystemPrompt: systemPrompt(prepared.input),
        requestUi: async () => undefined,
        agentControl,
        fastMode: {
          get: () => prepared.input.fastMode,
          set: async () => undefined,
        },
      },
    };
    const handle: SubagentHandleState = {
      handleId,
      parentSessionId: prepared.parent.parentSessionId,
      anchorPartId,
      workingDirectory: prepared.parent.workingDirectory,
      task: prepared.input.task,
      profile: prepared.input.profile,
      resolvedModel: prepared.resolvedModel,
      tools: prepared.tools,
      instructions: prepared.input.instructions,
      fastMode: prepared.input.fastMode,
      retain: prepared.input.retain,
      remainingDepth: prepared.remainingDepth,
      notifyOnCompletion,
      scope,
      completion,
      runtimeOptions,
      parentPiHandle: parentHandle,
      status: "queued",
      activityRevision: 0,
      streaming: false,
      parts: [],
      waiters: 0,
      completionDisposition: notifyOnCompletion ? "pending" : "waited",
    };
    const inserted = yield* SubscriptionRef.modify(coordinator.state, (state) => {
      const owned = [...state.handles.values()].filter(
        (item) => item.parentSessionId === prepared.parent.parentSessionId,
      ).length;
      if (owned >= MAX_HANDLES_PER_PARENT) return [false, state] as const;
      const handles = new Map(state.handles);
      handles.set(handleId, handle);
      return [true, { revision: state.revision + 1, handles }] as const;
    });
    if (!inserted)
      return yield* new SubagentError({
        operation: "start",
        message: `An agent may own at most ${MAX_HANDLES_PER_PARENT} subagent handles.`,
      });
    const worker = executeInitial(handleId, prepared).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Effect.void,
        onFailure: (cause) => failHandle(handleId, cause),
      }),
      Effect.ensuring(
        Effect.gen(function* () {
          const current = yield* requireHandleById(handleId).pipe(
            Effect.catchTag("SubagentError", () => Effect.succeed(undefined)),
          );
          if (current && !current.retain) {
            if (current.privateSessionId) yield* releaseDirectChildren(current.privateSessionId);
            yield* Scope.close(current.scope, Exit.void);
            yield* mutateHandle(handleId, (released) => ({ ...released, piHandle: undefined }));
          }
        }),
      ),
      Effect.andThen(
        prepared.input.retain
          ? Effect.void
          : Effect.sleep(RESULT_RETENTION).pipe(Effect.andThen(remove(handleId))),
      ),
    );
    yield* FiberMap.run(coordinator.fibers, handleId, worker);
    return {
      handleId,
      receipt: {
        handleId,
        task: prepared.input.task,
        profile: prepared.input.profile,
        status: "queued",
        retained: prepared.input.retain,
        fastMode: prepared.input.fastMode,
        maxDepth: prepared.remainingDepth,
        resolvedModel: prepared.resolvedModel,
      } satisfies SubagentStartReceipt,
    };
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? SubscriptionRef.update(coordinator.state, (state) => removeHandle(state, handleId)).pipe(
            Effect.andThen(FiberMap.remove(coordinator.fibers, handleId)),
            Effect.andThen(Scope.close(scope, Exit.void)),
          )
        : Effect.void,
    ),
  );
});

const remove = Effect.fn("Subagents.remove")(function* (handleId: SubagentHandleId) {
  const coordinator = yield* SubagentCoordinator;
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
  if (!handle) return;
  yield* SubscriptionRef.update(coordinator.state, (state) => removeHandle(state, handleId));
  yield* Scope.close(handle.scope, Exit.void);
});

export const start = Effect.fn("Subagents.start")(function* (
  input: SubagentTaskInput,
  parent: SubagentParentRuntime,
  anchorPartId = `subagent-${crypto.randomUUID()}`,
) {
  const [prepared] = yield* prepareTasks([input], parent);
  if (!prepared)
    return yield* new SubagentError({ operation: "start", message: "Task preflight failed" });
  return (yield* startPrepared(prepared, anchorPartId, true)).receipt;
});

export const run = Effect.fn("Subagents.run")(function* (
  input: SubagentTaskInput,
  parent: SubagentParentRuntime,
  onUpdate?: (value: Schema.Schema.Type<typeof Schema.Json>) => void,
  anchorPartId = `subagent-${crypto.randomUUID()}`,
) {
  const [prepared] = yield* prepareTasks([input], parent);
  if (!prepared)
    return yield* new SubagentError({ operation: "run", message: "Task preflight failed" });
  const started = yield* startPrepared(prepared, anchorPartId, false);
  return yield* wait(parent.parentSessionId, started.handleId, onUpdate).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? close(parent.parentSessionId, started.handleId).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
});

export const parallel = Effect.fn("Subagents.parallel")(function* (
  input: ParallelSubagentInput,
  parent: SubagentParentRuntime,
  onUpdate?: (value: Schema.Schema.Type<typeof Schema.Json>) => void,
  anchorPartId = `subagent-${crypto.randomUUID()}`,
) {
  const parsed = yield* Schema.decodeUnknownEffect(ParallelSubagentInput)(input).pipe(
    Effect.mapError(
      (error) => new SubagentError({ operation: "parallel", message: error.message }),
    ),
  );
  const prepared = yield* prepareTasks(parsed.tasks, parent);
  const coordinator = yield* SubagentCoordinator;
  const started: Array<SubagentHandleId> = [];
  const execute = Effect.gen(function* () {
    for (const task of prepared) {
      const handle = yield* startPrepared(task, anchorPartId, false);
      started.push(handle.handleId);
    }
    const results = yield* Effect.forEach(
      started,
      (handleId) =>
        wait(parent.parentSessionId, handleId, (latest) =>
          onUpdate?.(
            jsonValue({
              mode: "parallel",
              completed: started.filter(
                (id) => SubscriptionRef.getUnsafe(coordinator.state).handles.get(id)?.result,
              ).length,
              total: started.length,
              latest,
            }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return jsonValue({
      mode: "parallel",
      completed: results.length,
      total: results.length,
      results,
    });
  });
  return yield* execute.pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.forEach(started, (handleId) => close(parent.parentSessionId, handleId), {
            concurrency: "unbounded",
            discard: true,
          })
        : Effect.void,
    ),
  );
});

export const wait = Effect.fn("Subagents.wait")(function* (
  parentSessionId: string,
  rawHandleId: string,
  onUpdate?: (value: Schema.Schema.Type<typeof Schema.Json>) => void,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  const coordinator = yield* SubagentCoordinator;
  const registered = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.handles.get(handle.handleId);
    if (!current || current.result || current.completionDisposition !== "pending")
      return [false, state] as const;
    return [
      true,
      updateHandle(state, handle.handleId, (value) => ({
        ...value,
        waiters: value.waiters + 1,
      })),
    ] as const;
  });
  onUpdate?.(jsonValue(activityOf(handle)));
  const observer = onUpdate
    ? yield* SubscriptionRef.changes(coordinator.state).pipe(
        Stream.map((state) => state.handles.get(handle.handleId)),
        Stream.filter((value): value is SubagentHandleState => value !== undefined),
        Stream.debounce("150 millis"),
        Stream.runForEach((value) => Effect.sync(() => onUpdate(jsonValue(activityOf(value))))),
        Effect.forkChild,
      )
    : undefined;
  const completed = yield* Deferred.await(handle.completion).pipe(
    Effect.timeout(WAIT_TIMEOUT),
    asError("wait"),
    Effect.onExit((exit) =>
      registered
        ? SubscriptionRef.modify(coordinator.state, (state) => {
            const current = state.handles.get(handle.handleId);
            if (!current) return [false, state] as const;
            const waiters = Math.max(0, current.waiters - 1);
            const notify =
              Exit.isFailure(exit) &&
              waiters === 0 &&
              current.result !== undefined &&
              current.completionDisposition === "waited";
            return [
              notify,
              updateHandle(state, handle.handleId, (value) => ({
                ...value,
                waiters,
                completionDisposition: notify ? "notifying" : value.completionDisposition,
              })),
            ] as const;
          }).pipe(
            Effect.flatMap((notify) => (notify ? deliverCompletion(handle.handleId) : Effect.void)),
          )
        : Effect.void,
    ),
  );
  if (observer) yield* Fiber.interrupt(observer);
  if (!handle.retain)
    yield* Effect.sleep("500 millis").pipe(
      Effect.andThen(FiberMap.remove(coordinator.fibers, handle.handleId)),
      Effect.andThen(remove(handle.handleId)),
      Effect.forkIn(coordinator.scope),
    );
  return jsonValue(completed);
});

export const prompt = Effect.fn("Subagents.prompt")(function* (
  parentSessionId: string,
  rawHandleId: string,
  text: string,
  delivery: "prompt" | "follow-up",
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  if (!handle.retain)
    return yield* new SubagentError({
      operation: delivery,
      message:
        "This subagent was created for one-shot work. Spawn with retain: true to use multi-turn prompts.",
    });
  const normalized = text.trim();
  if (!normalized)
    return yield* new SubagentError({ operation: delivery, message: "Prompt text is required" });
  const coordinator = yield* SubagentCoordinator;
  const claimed = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.handles.get(handle.handleId);
    if (
      !current ||
      current.parentSessionId !== parentSessionId ||
      current.status === "queued" ||
      current.status === "running"
    )
      return [false, state] as const;
    return [
      true,
      updateHandle(state, handle.handleId, (value) => ({
        ...value,
        status: "queued",
        error: undefined,
        result: undefined,
        completionDisposition: "waited",
        activityRevision: value.activityRevision + 1,
      })),
    ] as const;
  });
  if (!claimed)
    return yield* new SubagentError({
      operation: delivery,
      message: "That retained subagent already has active work; steer or abort it instead",
    });
  const slot = yield* RcMap.get(coordinator.slots, handle.workingDirectory).pipe(
    Effect.provideService(Scope.Scope, handle.scope),
  );
  const result = yield* slot
    .withPermit(
      mutateHandle(handle.handleId, (current) => ({ ...current, status: "running" })).pipe(
        Effect.andThen(observeTurn(handle.handleId, delivery, normalized)),
      ),
    )
    .pipe(
      Effect.onInterrupt(() =>
        handle.piHandle ? handle.piHandle.abort().pipe(Effect.ignore) : Effect.void,
      ),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? mutateHandle(handle.handleId, (current) => ({
              ...current,
              result: exit.value,
              status: exit.value.status,
            }))
          : mutateHandle(handle.handleId, (current) => ({
              ...current,
              status: Cause.hasInterrupts(exit.cause) ? "aborted" : "error",
              streaming: false,
              error: boundedError(Cause.pretty(exit.cause)),
            })),
      ),
    );
  return jsonValue(result);
});

export const steer = Effect.fn("Subagents.steer")(function* (
  parentSessionId: string,
  rawHandleId: string,
  text: string,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  if (handle.status !== "running" || !handle.piHandle)
    return yield* new SubagentError({
      operation: "steer",
      message: "That subagent is no longer available to steer",
    });
  const normalized = text.trim();
  if (!normalized)
    return yield* new SubagentError({ operation: "steer", message: "Steer text is required" });
  yield* handle.piHandle.steer(normalized).pipe(asError("steer"), Effect.asVoid);
});

export const abort = Effect.fn("Subagents.abort")(function* (
  parentSessionId: string,
  rawHandleId: string,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  if (handle.status !== "queued" && handle.status !== "running") return;
  const coordinator = yield* SubagentCoordinator;
  if (handle.privateSessionId) yield* abortDirectChildren(handle.privateSessionId);
  yield* mutateHandle(handle.handleId, (current) => ({
    ...current,
    status: "aborted",
    streaming: false,
  }));
  if (handle.piHandle) yield* handle.piHandle.abort().pipe(asError("abort"));
  else yield* FiberMap.remove(coordinator.fibers, handle.handleId);
});

export const close = Effect.fn("Subagents.close")(function* (
  parentSessionId: string,
  rawHandleId: string,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  const coordinator = yield* SubagentCoordinator;
  if (handle.privateSessionId) yield* releaseDirectChildren(handle.privateSessionId);
  yield* Deferred.fail(
    handle.completion,
    new SubagentError({ operation: "close", message: "The subagent was closed" }),
  );
  yield* SubscriptionRef.update(coordinator.state, (state) => removeHandle(state, handle.handleId));
  yield* FiberMap.remove(coordinator.fibers, handle.handleId);
  yield* Scope.close(handle.scope, Exit.void);
  return jsonValue({ handleId: handle.handleId, closed: true });
});

export const abortParentChildren = Effect.fn("Subagents.abortParentChildren")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  const handles = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) =>
      handle.parentSessionId === parentSessionId &&
      (handle.status === "queued" || handle.status === "running"),
  );
  yield* Effect.forEach(handles, (handle) => abort(parentSessionId, handle.handleId), {
    concurrency: "unbounded",
    discard: true,
  });
});

export const releaseParent = Effect.fn("Subagents.releaseParent")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  const handles = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) => handle.parentSessionId === parentSessionId,
  );
  yield* Effect.forEach(handles, (handle) => close(parentSessionId, handle.handleId), {
    concurrency: "unbounded",
    discard: true,
  });
});

const parentActivities = (state: SubagentCoordinatorState, parentSessionId: string) =>
  [...state.handles.values()]
    .filter((handle) => handle.parentSessionId === parentSessionId)
    .map(activityOf);

const backgroundActive = (activities: ReadonlyArray<SubagentActivity>) =>
  activities.some((activity) => activity.status === "queued" || activity.status === "running");

export const observe = Effect.fn("Subagents.observe")(function* (parentSessionId: string) {
  const coordinator = yield* SubagentCoordinator;
  return Stream.suspend(() => {
    let previous: ReadonlyMap<SubagentHandleId, SubagentActivity> | undefined;
    let previousBackground = false;
    return SubscriptionRef.changes(coordinator.state).pipe(
      Stream.flatMap((state) => {
        const activities = parentActivities(state, parentSessionId);
        const current = new Map(
          activities.map((activity) => [activity.handleId, activity] as const),
        );
        const background = backgroundActive(activities);
        if (!previous) {
          previous = current;
          previousBackground = background;
          return Stream.succeed<SubagentUpdate>({
            _tag: "Snapshot",
            revision: state.revision,
            parentSessionId,
            activities,
            backgroundActive: background,
          });
        }
        const updates: SubagentUpdate[] = [];
        for (const activity of activities) {
          if (previous.get(activity.handleId)?.revision !== activity.revision)
            updates.push({
              _tag: "Activity",
              revision: state.revision,
              parentSessionId,
              activity,
            });
        }
        for (const handleId of previous.keys()) {
          if (!current.has(handleId))
            updates.push({
              _tag: "Removed",
              revision: state.revision,
              parentSessionId,
              handleId,
            });
        }
        if (background !== previousBackground)
          updates.push({
            _tag: "Background",
            revision: state.revision,
            parentSessionId,
            active: background,
          });
        previous = current;
        previousBackground = background;
        return Stream.fromIterable(updates);
      }),
    );
  });
});
