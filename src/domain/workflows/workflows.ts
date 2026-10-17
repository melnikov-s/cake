import { resolveCakeModelSelection } from "../model-presets/cake-model-selection";
import {
  Cause,
  Config,
  DateTime,
  Effect,
  Exit,
  FiberMap,
  Schema,
  Predicate,
  PubSub,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect";
import { availableParallelism } from "node:os";
import {
  WorkflowRunId,
  type WorkflowOwner,
  type WorkflowRunTarget,
  type WorkflowStartInput,
  type WorkflowRelaunchInput,
  type WorkflowWorkerTarget,
  type WorkflowSaveInput,
  type WorkflowSavedTarget,
  type WorkflowRunReceipt,
  type WorkflowProgram,
  type WorkflowCatalogUpdate,
  type WorkflowRunUpdate,
} from "../../contracts/workflows/workflow-data";
import { workflowSummary } from "../../contracts/workflows/workflow-projection";
import { WorkflowScripts } from "../../services/pi/WorkflowScripts";
import { WorkflowWorkers } from "../../services/pi/WorkflowWorkers";
import {
  WorkflowRunStorage,
  type WorkflowCheckpoint,
} from "../../services/storage/WorkflowRunStorage";
import { WorkflowSupervisor } from "../../services/workflows/WorkflowSupervisor";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import { acquireOptions as acquireProjectSessionOptions } from "../project-sessions/projectSessionRuntime";
import { getRun, makeLiveRun, updateRun, workflowError } from "./run-state";
import { executeRun } from "./run-engine";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

const asError = (operation: string) =>
  Effect.mapError((error: unknown) =>
    workflowError(
      operation,
      "invalid-input",
      error instanceof Error ? error.message : String(error),
    ),
  );
const requireEnabled = Effect.fn("Workflows.requireEnabled")(function* (operation: string) {
  if (!(yield* ApplicationState).snapshot().experimentalFeatures?.dynamicWorkflows)
    return yield* workflowError(
      operation,
      "invalid-state",
      "Dynamic workflows are disabled. Enable Settings → Experimental → Dynamic workflows first.",
    );
});

const ownerLocation = Effect.fn("Workflows.ownerLocation")(function* (owner: WorkflowOwner) {
  return yield* findLocation({ sessionId: owner.sessionId }).pipe(asError("owner"));
});
const ownerSnapshot = Effect.fn("Workflows.ownerSnapshot")(function* (owner: WorkflowOwner) {
  const sessions = yield* CakeSessionRuntimes;
  const snapshot = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* sessions.acquireSession(owner.sessionId).pipe(asError("owner"));
      if (handle.profile !== "ProjectSession")
        return yield* workflowError(
          "owner",
          "invalid-input",
          "Only a Project Session can own a workflow.",
        );
      return yield* handle.snapshot().pipe(asError("owner"));
    }),
  );
  if (!snapshot.model)
    return yield* workflowError(
      "owner",
      "invalid-input",
      "The owning session has no selected model.",
    );
  return { ...snapshot, model: snapshot.model };
});
const receipt = (checkpoint: WorkflowCheckpoint): WorkflowRunReceipt => ({
  sessionId: checkpoint.run.ownerSessionId,
  runId: checkpoint.run.id,
  name: checkpoint.run.program.meta.name,
  status: checkpoint.run.status,
});

const deliverCompletion = Effect.fn("Workflows.deliverCompletion")(function* (
  target: WorkflowRunTarget,
) {
  const current = yield* getRun(target);
  const run = current.checkpoint.run;
  const sessions = yield* CakeSessionRuntimes;
  const familyStorage = yield* SessionFamilyStorage;
  const text = (
    run.error ?? (Predicate.isString(run.result) ? run.result : JSON.stringify(run.result ?? null))
  ).slice(0, 100_000);
  if (current.checkpoint.completionDelivery !== "delivered") {
    yield* Effect.scoped(
      Effect.gen(function* () {
        // The launch turn and all observers may have ended. Reassemble a cold owner.
        const handle = yield* sessions.acquireSession(target.sessionId).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              const location = yield* ownerLocation({ sessionId: target.sessionId });
              return yield* sessions.acquire(
                yield* acquireProjectSessionOptions({
                  location,
                  sessionId: target.sessionId,
                  newSession: false,
                }),
              );
            }),
          ),
          asError("report"),
        );
        const report = `Dynamic workflow ${run.program.meta.name} ${run.status}. Run: ${run.id}.\n${text}`;
        yield* handle.followUp(report).pipe(asError("report"));
      }),
    );
    yield* updateRun(target.runId, (checkpoint) => ({
      ...checkpoint,
      completionDelivery: "delivered",
    }));
  }
  // One assignment can launch several runs. Settle only that assignment, once
  // all of its own runs have delivered, and include all their results.
  const supervisor = yield* WorkflowSupervisor;
  if (current.checkpoint.completionTurnIds.length > 0) {
    const location = yield* ownerLocation(target);
    const executing = yield* sessions.executingTurnIds({
      sessionId: target.sessionId,
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    });
    if (current.checkpoint.completionTurnIds.some((turnId) => executing.includes(turnId)))
      return yield* workflowError(
        "assignment",
        "invalid-state",
        "Wait for the initiating turn to finish before settling its workflows.",
      );
  }
  const records = [...(yield* SubscriptionRef.get(supervisor.state)).values()].map(
    (live) => live.checkpoint,
  );
  for (const turnId of current.checkpoint.completionTurnIds) {
    const related = records.filter(
      (record) =>
        record.run.ownerSessionId === target.sessionId && record.completionTurnIds.includes(turnId),
    );
    if (related.some((record) => record.completionDelivery !== "delivered")) continue;
    const successful = related.every((record) => record.run.status === "complete");
    const reportText = related
      .map((record) => {
        const value =
          record.run.error ??
          (Predicate.isString(record.run.result)
            ? record.run.result
            : JSON.stringify(record.run.result ?? null));
        return related.length === 1
          ? value
          : `${record.run.program.meta.name} (${record.run.status}):\n${value}`;
      })
      .join("\n\n")
      .slice(0, 100_000);
    yield* familyStorage
      .settleTurn(turnId, successful ? "complete" : "failed", {
        outcome: successful ? "result" : "failed",
        text: reportText,
      })
      .pipe(asError("report"));
  }
});

const queueCompletion = Effect.fn("Workflows.queueCompletion")(function* (
  target: WorkflowRunTarget,
) {
  const supervisor = yield* WorkflowSupervisor;
  yield* FiberMap.run(
    supervisor.reports,
    target.runId,
    deliverCompletion(target).pipe(
      Effect.tapError((error) =>
        error.operation === "assignment"
          ? Effect.void
          : Effect.logError("Workflow report delivery will retry", error),
      ),
      Effect.retry(Schedule.spaced("1 second")),
    ),
    { onlyIfMissing: true },
  );
});

const launch = Effect.fn("Workflows.launch")(function* (
  checkpoint: WorkflowCheckpoint,
  previousSteps: WorkflowCheckpoint["run"]["steps"],
) {
  const supervisor = yield* WorkflowSupervisor;
  const current = yield* getRun({
    sessionId: checkpoint.run.ownerSessionId,
    runId: checkpoint.run.id,
  });
  const task = Effect.uninterruptibleMask((restore) =>
    restore(
      Effect.scoped(executeRun(checkpoint.run.id, checkpoint.run.program, previousSteps)),
    ).pipe(
      Effect.exit,
      Effect.tap(() => FiberMap.clear(current.workers)),
      Effect.flatMap((exit) =>
        updateRun(checkpoint.run.id, (record) => ({
          ...record,
          run: {
            ...record.run,
            ...(Exit.isSuccess(exit) && record.run.status !== "stopping"
              ? {
                  status: "complete" as const,
                  result: exit.value ?? null,
                  steps: record.run.steps.map((step) =>
                    step.status === "running" || step.status === "queued"
                      ? { ...step, status: "aborted" as const }
                      : step,
                  ),
                }
              : {
                  status:
                    record.run.status === "stopping"
                      ? ("stopped" as const)
                      : Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                        ? ("interrupted" as const)
                        : ("error" as const),
                  error: Exit.isFailure(exit)
                    ? String(exit.cause).slice(0, 16_384)
                    : "Workflow failed.",
                  steps: record.run.steps.map((step) =>
                    step.status === "running" || step.status === "queued"
                      ? { ...step, status: "aborted" as const }
                      : step,
                  ),
                }),
          },
        })),
      ),
      Effect.flatMap(() =>
        queueCompletion({ sessionId: checkpoint.run.ownerSessionId, runId: checkpoint.run.id }),
      ),
      Effect.tapError((error) =>
        Effect.logError("Workflow completion or checkpoint failed", error),
      ),
      Effect.ensuring(FiberMap.clear(current.workers)),
    ),
  );
  yield* FiberMap.run(supervisor.runs, checkpoint.run.id, task);
});

/** Persist accepted intent, fork into the backend scope, return immediately. */
const startPrepared = Effect.fn("Workflows.startPrepared")(function* (
  input: WorkflowStartInput,
  program: WorkflowProgram,
  callerSessionId?: string,
) {
  yield* requireEnabled("start");
  const location = yield* ownerLocation(input);
  const sessions = yield* CakeSessionRuntimes;
  const snapshot = yield* ownerSnapshot(input);
  const executingTurnIds = yield* sessions.executingTurnIds({
    sessionId: input.sessionId,
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
  });
  const id = yield* Schema.decodeUnknownEffect(WorkflowRunId)(crypto.randomUUID()).pipe(
    Effect.orDie,
  );
  const now = DateTime.formatIso(yield* DateTime.now);
  const configured = yield* Config.int("CAKE_WORKFLOW_MAX_CONCURRENT_AGENTS").pipe(
    Config.withDefault(Math.min(16, availableParallelism())),
    asError("configuration"),
  );
  if (configured < 1 || configured > 256)
    return yield* workflowError(
      "configuration",
      "invalid-input",
      "Concurrency must be between 1 and 256.",
    );
  const appState = (yield* ApplicationState).snapshot();
  const projectSettings = appState.projects.find(
    (project) => project.path === location.projectPath,
  )?.settings;
  const checkpoint: WorkflowCheckpoint = {
    run: {
      id,
      ownerSessionId: input.sessionId,
      projectPath: location.projectPath,
      workingDirectory: location.workingDirectory,
      program,
      status: "running",
      revision: 0,
      execution: 1,
      maxConcurrentAgents: configured,
      createdAt: now,
      updatedAt: now,
      phases: [],
      logs: [],
      steps: [],
    },
    // Snapshot the configured default once so omitted agent models stay stable across
    // resumes; the caller's current model applies only when no default preset exists.
    inheritedModel: resolveCakeModelSelection(
      undefined,
      { presets: appState.modelPresets, defaultPresetId: appState.defaultModelPresetId },
      {
        provider: snapshot.model.provider,
        modelId: snapshot.model.id,
        thinkingLevel: snapshot.thinkingLevel,
        fastMode: snapshot.fastMode ?? false,
      },
    ),
    commonInstructions: [
      appState.globalCustomInstructions,
      projectSettings?.customInstructions,
      location.managedWorktree ? projectSettings?.worktreeSetupInstructions : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
    previousPrograms: [],
    workers: [],
    completionTurnIds: (yield* (yield* SessionFamilyStorage).state().pipe(asError("start"))).turns
      .filter(
        (turn) =>
          callerSessionId === input.sessionId &&
          turn.sessionId === input.sessionId &&
          !turn.reported &&
          executingTurnIds.includes(turn.turnId),
      )
      .map((turn) => turn.turnId),
    completionDelivery: "pending",
  };
  const storage = yield* WorkflowRunStorage;
  const supervisor = yield* WorkflowSupervisor;
  yield* storage.save(checkpoint, null);
  const live = yield* makeLiveRun(checkpoint);
  yield* SubscriptionRef.update(supervisor.state, (current) => new Map(current).set(id, live));
  yield* launch(checkpoint, []);
  return receipt(checkpoint);
});

/** Explicit user-requested execution does not require a second confirmation. */
export const start = Effect.fn("Workflows.start")(function* (
  input: WorkflowStartInput,
  callerSessionId?: string,
) {
  yield* requireEnabled("start");
  const location = yield* ownerLocation(input);
  const program = yield* (yield* WorkflowScripts).read(location, input.scriptPath, input.args);
  return yield* startPrepared(input, program, callerSessionId);
});

/** A suggestion blocks on the existing renderer request lifecycle, never on script execution. */
export const propose = Effect.fn("Workflows.propose")(function* (
  input: WorkflowStartInput,
  requester: { readonly _tag: "ProjectSession" | "CakeChatSession"; readonly sessionId: string },
  callerSignal: AbortSignal,
) {
  if (callerSignal.aborted) return { choice: "cancelled" as const };
  yield* requireEnabled("propose");
  const application = yield* ApplicationState;
  const disabled = new AbortController();
  const signal = AbortSignal.any([callerSignal, disabled.signal]);
  yield* application.changes().pipe(
    Stream.filter((projection) => !projection.state.experimentalFeatures?.dynamicWorkflows),
    Stream.take(1),
    Stream.runForEach(() => Effect.sync(() => disabled.abort())),
    Effect.forkScoped({ startImmediately: true }),
  );
  const location = yield* ownerLocation(input);
  yield* ownerSnapshot(input);
  const program = yield* (yield* WorkflowScripts).read(location, input.scriptPath, input.args);
  const choice = yield* (yield* RendererRequestCoordinator)
    .requestUiForTarget(requester, {
      kind: "workflow-choice",
      title: program.meta.name,
      message: program.meta.description,
      workflow: { ownerSessionId: input.sessionId, program },
      signal,
    })
    .pipe(asError("propose"));
  if (signal.aborted || choice === undefined) return { choice: "cancelled" as const };
  if (choice === "normal") return { choice: "normal" as const };
  if (choice !== "workflow")
    return yield* workflowError("propose", "invalid-input", "Invalid execution choice.");
  const run = yield* startPrepared(
    input,
    program,
    requester._tag === "ProjectSession" ? requester.sessionId : undefined,
  );
  return { choice: "workflow" as const, run };
}, Effect.scoped);

export const list = Effect.fn("Workflows.list")(function* (owner: WorkflowOwner) {
  yield* ownerLocation(owner);
  const records = yield* (yield* WorkflowRunStorage).list(owner.sessionId);
  const result = [];
  for (const record of records) {
    const target = { sessionId: owner.sessionId, runId: record.id };
    const live = yield* getRun(target);
    if (
      ["complete", "error", "stopped"].includes(live.checkpoint.run.status) &&
      live.checkpoint.completionDelivery === "pending"
    )
      yield* queueCompletion(target);
    result.push(workflowSummary(live.checkpoint.run));
  }
  return result;
});
export const inspect = Effect.fn("Workflows.inspect")(function* (target: WorkflowRunTarget) {
  return (yield* getRun(target)).checkpoint.run;
});

export const observe = Effect.fn("Workflows.observe")(function* (owner: WorkflowOwner) {
  yield* list(owner);
  const supervisor = yield* WorkflowSupervisor;
  // SubscriptionRef changes begins with a current snapshot and has no subscribe/read gap.
  return SubscriptionRef.changes(supervisor.state).pipe(
    Stream.mapAccum(
      (): ReadonlyMap<string, number> | undefined => undefined,
      (previous, state) => {
        const runs = [...state.values()]
          .filter((live) => live.checkpoint.run.ownerSessionId === owner.sessionId)
          .map((live) => workflowSummary(live.checkpoint.run));
        const revision = runs.reduce((sum, run) => sum + run.revision + 1, 0);
        const events: WorkflowCatalogUpdate[] =
          previous === undefined
            ? [{ _tag: "Snapshot", ownerSessionId: owner.sessionId, revision, runs }]
            : runs
                .filter((run) => previous.get(run.id) !== run.revision)
                .map((run) => ({ _tag: "RunChanged", revision, run }));
        return [new Map(runs.map((run) => [run.id, run.revision])), events] as const;
      },
    ),
  );
});
export const observeRun = Effect.fn("Workflows.observeRun")(function* (target: WorkflowRunTarget) {
  yield* getRun(target);
  const supervisor = yield* WorkflowSupervisor;
  return Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the initial snapshot. Each trigger reads current authority,
      // so interleaved checkpoint/activity streams cannot regress the run snapshot.
      const subscription = yield* PubSub.subscribe(supervisor.activity);
      const activity = Stream.fromEffect(PubSub.take(subscription)).pipe(
        Stream.repeat(Schedule.forever),
        Stream.filter((event) => event.runId === target.runId),
        Stream.map((event) => event.activity),
      );
      const changes = SubscriptionRef.changes(supervisor.state).pipe(Stream.map(() => undefined));
      return changes.pipe(
        Stream.merge(activity),
        Stream.mapAccumEffect(
          () => ({ runRevision: -1, sequence: -1 }),
          (previous, worker) =>
            Effect.gen(function* () {
              const current = (yield* SubscriptionRef.get(supervisor.state)).get(target.runId);
              if (!current) return [previous, []] as const;
              const run = current.checkpoint.run;
              let sequence = previous.sequence;
              const events: WorkflowRunUpdate[] = [];
              if (run.revision > previous.runRevision)
                events.push({
                  _tag: previous.runRevision === -1 ? "Snapshot" : "RunChanged",
                  revision: ++sequence,
                  run,
                });
              const step = worker && run.steps.find((candidate) => candidate.id === worker.stepId);
              if (
                worker &&
                worker.execution === run.execution &&
                step?.execution === worker.execution &&
                step.attempt === worker.attempt
              )
                events.push({ _tag: "WorkerActivity", revision: ++sequence, activity: worker });
              return [{ runRevision: run.revision, sequence }, events] as const;
            }),
        ),
      );
    }),
  );
});
export const pause = Effect.fn("Workflows.pause")(function* (target: WorkflowRunTarget) {
  const live = yield* getRun(target);
  if (live.checkpoint.run.status !== "running")
    return yield* workflowError("pause", "invalid-state", "Only a running workflow can be paused.");
  yield* live.schedulingGate.close;
  yield* updateRun(target.runId, (checkpoint) => ({
    ...checkpoint,
    run: { ...checkpoint.run, status: "paused" },
  }));
});
export const resume = Effect.fn("Workflows.resume")(function* (target: WorkflowRunTarget) {
  const live = yield* getRun(target);
  if (live.checkpoint.run.status !== "paused")
    return yield* workflowError(
      "resume",
      "invalid-state",
      "Only a paused workflow can be resumed.",
    );
  yield* updateRun(target.runId, (checkpoint) => ({
    ...checkpoint,
    run: { ...checkpoint.run, status: "running" },
  }));
  yield* live.schedulingGate.open;
});
export const stop = Effect.fn("Workflows.stop")(function* (target: WorkflowRunTarget) {
  const live = yield* getRun(target);
  if (!["running", "paused"].includes(live.checkpoint.run.status))
    return yield* workflowError("stop", "invalid-state", "Workflow is not running.");
  yield* updateRun(target.runId, (checkpoint) => ({
    ...checkpoint,
    run: {
      ...checkpoint.run,
      status: "stopping",
      steps: checkpoint.run.steps.map((step) =>
        step.status === "queued" ? { ...step, status: "aborted" as const } : step,
      ),
    },
  }));
  const supervisor = yield* WorkflowSupervisor;
  yield* FiberMap.remove(supervisor.runs, target.runId);
  yield* FiberMap.clear(live.workers);
  const final = yield* getRun(target);
  if (final.checkpoint.run.status === "stopping")
    yield* updateRun(target.runId, (checkpoint) => ({
      ...checkpoint,
      run: {
        ...checkpoint.run,
        status: "stopped",
        steps: checkpoint.run.steps.map((step) =>
          step.status === "running" ? { ...step, status: "aborted" as const } : step,
        ),
      },
    }));
});
export const relaunch = Effect.fn("Workflows.relaunch")(function* (input: WorkflowRelaunchInput) {
  yield* requireEnabled("relaunch");
  const live = yield* getRun(input);
  const supervisor = yield* WorkflowSupervisor;
  if (
    ["running", "paused", "stopping"].includes(live.checkpoint.run.status) ||
    (yield* FiberMap.has(supervisor.runs, input.runId)) ||
    (yield* FiberMap.has(supervisor.reports, input.runId))
  )
    return yield* workflowError(
      "relaunch",
      "invalid-state",
      "Previous execution is still active or cleaning up.",
    );
  const program =
    input.scriptPath === undefined
      ? live.checkpoint.run.program
      : yield* (yield* WorkflowScripts).read(
          live.checkpoint.run,
          input.scriptPath,
          live.checkpoint.run.program.args,
        );
  const checkpoint = yield* updateRun(input.runId, (current) => {
    const run = { ...current.run };
    delete run.error;
    delete run.result;
    return {
      ...current,
      previousPrograms: [...current.previousPrograms, current.run.program],
      completionDelivery: "pending",
      run: {
        ...run,
        program,
        execution: run.execution + 1,
        status: "running",
        steps: [],
        phases: [],
        logs: [],
      },
    };
  });
  yield* live.schedulingGate.open;
  yield* launch(checkpoint, live.checkpoint.run.steps);
  return receipt(checkpoint);
});

const workerTarget = Effect.fn("Workflows.workerTarget")(function* (target: WorkflowWorkerTarget) {
  const live = yield* getRun(target);
  const step = live.checkpoint.run.steps.find((item) => item.id === target.stepId);
  if (
    !step ||
    step.execution !== target.execution ||
    live.checkpoint.run.execution !== target.execution
  )
    return yield* workflowError(
      "worker",
      "not-found",
      "Worker target is missing or belongs to a previous execution.",
    );
  return { live, step };
});
export const stopWorker = Effect.fn("Workflows.stopWorker")(function* (
  target: WorkflowWorkerTarget,
) {
  const { live, step } = yield* workerTarget(target);
  if (!["queued", "running"].includes(step.status))
    return yield* workflowError("stopWorker", "invalid-state", "Worker is not active.");
  yield* updateRun(target.runId, (checkpoint) => ({
    ...checkpoint,
    run: {
      ...checkpoint.run,
      steps: checkpoint.run.steps.map((item) =>
        item.id === step.id ? { ...item, status: "aborted" as const } : item,
      ),
    },
  }));
  yield* FiberMap.remove(live.workers, step.id);
});
export const restartWorker = Effect.fn("Workflows.restartWorker")(function* (
  target: WorkflowWorkerTarget,
) {
  const { live, step } = yield* workerTarget(target);
  if (step.status !== "running" || step.attempt >= 6)
    return yield* workflowError(
      "restartWorker",
      "invalid-state",
      "Only running workers with attempts remaining can restart.",
    );
  yield* updateRun(target.runId, (checkpoint) => ({
    ...checkpoint,
    run: {
      ...checkpoint.run,
      steps: checkpoint.run.steps.map((item) =>
        item.id === step.id ? { ...item, status: "queued" as const } : item,
      ),
    },
  }));
  yield* FiberMap.remove(live.workers, step.id);
});
export const inspectWorker = Effect.fn("Workflows.inspectWorker")(function* (
  target: WorkflowWorkerTarget,
) {
  const { live, step } = yield* workerTarget(target);
  const reference = live.checkpoint.workers.findLast(
    (item) =>
      item.stepId === step.id &&
      item.execution === target.execution &&
      item.attempt === step.attempt,
  );
  if (!reference)
    return {
      stepId: step.id,
      execution: target.execution,
      attempt: step.attempt,
      streaming: false,
      parts: [],
    };
  return yield* (yield* WorkflowWorkers).inspect(reference.reference, target, step.attempt);
});
export const saved = Effect.fn("Workflows.saved")(function* (owner: WorkflowOwner) {
  return yield* (yield* WorkflowScripts).list(yield* ownerLocation(owner));
});
export const inspectSaved = Effect.fn("Workflows.inspectSaved")(function* (
  input: WorkflowSavedTarget,
) {
  return yield* (yield* WorkflowScripts).read(yield* ownerLocation(input), input.scriptPath);
});
export const save = Effect.fn("Workflows.save")(function* (input: WorkflowSaveInput) {
  const { checkpoint } = yield* getRun(input);
  return yield* (yield* WorkflowScripts).save(
    checkpoint.run,
    checkpoint.run.program,
    input.name,
    input.location,
  );
});
