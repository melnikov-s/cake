import { Effect, Schema } from "effect";
import { AgentListInput } from "../../contracts/agent/agent-list-data";
import {
  type ArtifactLineageId,
  ArtifactRevisionNumber,
  artifactRevisionToRecord,
} from "../../contracts/artifacts/artifact-lineage";
import {
  ArtifactRuntimeError,
  type ArtifactRuntimeTarget,
} from "../../contracts/artifacts/artifact-runtime";
import {
  ArtifactRuntimePublishInput,
  ArtifactIdentityInput,
  ArtifactSetGlobalInput,
  ArtifactToolCallInput,
  handlesGlobalArtifactCommand,
} from "../../contracts/artifacts/global-artifact-control";
import {
  ArtifactScheduleConfigureInput,
  ArtifactScheduleIdentity,
} from "../../contracts/artifacts/artifact-schedules";
import type { ArtifactViewingReport } from "../../contracts/artifacts/artifact-viewing";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { ArtifactRuntime } from "../../services/artifact-runtime/ArtifactRuntime";
import { rejectArtifactRuntimeReentry } from "../../services/artifact-runtime/ArtifactRuntimeExecution";
import { ArtifactViews } from "../../services/artifacts/ArtifactViews";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { toJsonValue } from "../../utils/to-json-value";
import * as workflows from "./artifactWorkflows";
import * as schedules from "../automations/artifactSchedules";
export { handlesGlobalArtifactCommand } from "../../contracts/artifacts/global-artifact-control";

const current = Effect.fn("GlobalArtifacts.current")(function* (lineageId: ArtifactLineageId) {
  const revision = yield* (yield* ArtifactStorage).read(lineageId);
  if (!revision)
    return yield* new ArtifactRuntimeError({
      operation: "resolve",
      message: `Artifact not found: ${lineageId}`,
    });
  return revision;
});
const resolveRuntimeTarget = Effect.fn("GlobalArtifacts.resolveRuntimeTarget")(function* (
  lineageId: ArtifactLineageId,
) {
  const revision = yield* current(lineageId);
  const snapshot = revision.snapshot;
  if (snapshot.kind !== "widget" || !snapshot.payload.runtime) return undefined;
  return {
    lineageId,
    revision: revision.metadata.revision,
    runtime: snapshot.payload.runtime,
  } satisfies ArtifactRuntimeTarget;
});
const requireRuntime = Effect.fn("GlobalArtifacts.requireRuntime")(function* (
  lineageId: ArtifactLineageId,
) {
  const target = yield* resolveRuntimeTarget(lineageId);
  if (!target)
    return yield* new ArtifactRuntimeError({
      operation: "resolve",
      message: "This artifact has no executable backend logic",
    });
  return target;
});

export const executionStatus = Effect.fn("GlobalArtifacts.executionStatus")(function* (
  lineageId: ArtifactLineageId,
) {
  const target = yield* resolveRuntimeTarget(lineageId);
  return {
    ...(yield* (yield* ArtifactRuntime).status(lineageId)),
    executable: target !== undefined,
    backgroundPaused: yield* schedules.areArtifactSchedulesPaused(lineageId),
    schedules: yield* schedules.listArtifactSchedules(lineageId),
  };
});

export const callTool = Effect.fn("GlobalArtifacts.callTool")(function* (
  input: typeof ArtifactToolCallInput.Type,
  callingSessionId?: string,
  windowConnectionId?: number,
) {
  yield* rejectArtifactRuntimeReentry(input.lineageId, "call");
  const target = yield* requireRuntime(input.lineageId);
  return yield* (yield* ArtifactRuntime).call({
    target,
    name: input.name,
    input: input.input,
    ...(callingSessionId === undefined ? null : { callingSessionId }),
    ...(windowConnectionId === undefined ? null : { windowConnectionId }),
  });
});

export const controlRuntime = Effect.fn("GlobalArtifacts.controlRuntime")(function* (
  lineageId: ArtifactLineageId,
  action: "status" | "start" | "pause" | "resume" | "restart",
  callingSessionId?: string,
  windowConnectionId?: number,
) {
  if (action !== "status") yield* rejectArtifactRuntimeReentry(lineageId, action);
  if (action === "status") return yield* executionStatus(lineageId);
  const runtime = yield* ArtifactRuntime;
  const events = yield* ClientEvents;
  yield* Effect.gen(function* () {
    if (action === "pause") {
      yield* schedules.setArtifactSchedulesPaused(lineageId, true);
      yield* runtime.stop(lineageId, "stop", callingSessionId, windowConnectionId);
    } else {
      const target = yield* requireRuntime(lineageId);
      if (action === "restart")
        yield* runtime.stop(lineageId, "stop", callingSessionId, windowConnectionId);
      if (action === "resume") yield* schedules.setArtifactSchedulesPaused(lineageId, false);
      yield* runtime.lifecycle({
        target,
        event: "start",
        ...(callingSessionId === undefined ? null : { callingSessionId }),
        ...(windowConnectionId === undefined ? null : { windowConnectionId }),
      });
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => events.broadcast({ type: "artifact-execution-invalidated", lineageId })),
    ),
  );
  return yield* executionStatus(lineageId);
});

export const deleteArtifact = Effect.fn("GlobalArtifacts.deleteArtifact")(function* (
  lineageId: ArtifactLineageId,
) {
  yield* rejectArtifactRuntimeReentry(lineageId, "delete");
  yield* schedules.removeArtifactSchedules(lineageId);
  yield* (yield* ArtifactRuntime).stop(lineageId, "delete").pipe(
    Effect.tapError((error) => Effect.logWarning("Artifact cleanup hook failed", error)),
    Effect.ignore,
  );
  yield* workflows.deleteArtifact(lineageId);
  yield* (yield* ApplicationState).transact((state) =>
    Effect.succeed({
      ...state,
      widgetAttachments: state.widgetAttachments.filter((entry) => entry.lineageId !== lineageId),
    }),
  );
  (yield* ClientEvents).broadcast({ type: "artifact-catalog-invalidated", lineageId });
});

export const publishRuntime = Effect.fn("GlobalArtifacts.publishRuntime")(function* (
  input: typeof ArtifactRuntimePublishInput.Type,
  callingSessionId?: string,
) {
  yield* rejectArtifactRuntimeReentry(input.lineageId, "publish");
  if (!callingSessionId)
    return yield* new ArtifactRuntimeError({
      operation: "publish",
      message: "Publishing a source revision requires the actual publishing session",
    });
  const prior = yield* current(input.lineageId);
  if (prior.snapshot.kind !== "widget")
    return yield* new ArtifactRuntimeError({
      operation: "publish",
      message: "Only widget artifacts have backend logic",
    });
  const revisionNumber = yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
    input.expectedRevision + 1,
  );
  const published = yield* workflows.publish({
    sessionId: callingSessionId,
    lineageId: input.lineageId,
    expectedLatestRevision: input.expectedRevision,
    snapshot: {
      ...prior.snapshot,
      sessionId: callingSessionId,
      revision: revisionNumber,
      payload: { ...prior.snapshot.payload, runtime: input.runtime },
    },
    workingDirectory: prior.metadata.workingDirectory,
  });
  (yield* ClientEvents).broadcast({
    type: "artifact-updated",
    record: artifactRevisionToRecord(published),
  });
  return { lineageId: input.lineageId, revision: revisionNumber };
});

/** Window reports are data, never retention roots or runtime owners. Historical views are inert. */
export const reportViewing = Effect.fn("GlobalArtifacts.reportViewing")(function* (
  connectionId: number,
  report: ArtifactViewingReport,
) {
  const views = yield* ArtifactViews;
  const previous = (yield* views.read(connectionId)).windows.find(
    (window) => window.connectionId === connectionId,
  );
  yield* views.report(connectionId, report);
  const runtime = yield* ArtifactRuntime;
  const events = yield* ClientEvents;
  const key = (view: ArtifactViewingReport["visible"][number]) =>
    `${view.lineageId}@r${view.revision}:${view.surface}`;
  for (const prior of previous?.visible ?? []) {
    if (report.visible.some((view) => key(view) === key(prior))) continue;
    const target = yield* resolveRuntimeTarget(prior.lineageId);
    if (target?.revision === prior.revision) {
      if (previous?.active && key(previous.active) === key(prior))
        yield* runtime
          .lifecycle({
            target,
            event: "blur",
            viewId: `${connectionId}:${key(prior)}`,
            windowConnectionId: connectionId,
          })
          .pipe(Effect.ignore);
      yield* runtime
        .lifecycle({
          target,
          event: "unmount",
          viewId: `${connectionId}:${key(prior)}`,
          windowConnectionId: connectionId,
        })
        .pipe(Effect.ignore);
    }
  }
  for (const view of report.visible) {
    const target = yield* resolveRuntimeTarget(view.lineageId);
    if (!target || target.revision !== view.revision) continue;
    if (!(previous?.visible.some((prior) => key(prior) === key(view)) ?? false))
      yield* runtime
        .lifecycle({
          target,
          event: "start",
          viewId: `${connectionId}:${key(view)}`,
          windowConnectionId: connectionId,
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() =>
              events.broadcast({
                type: "artifact-execution-invalidated",
                lineageId: view.lineageId,
              }),
            ),
          ),
          Effect.ignore,
        );
    if (
      report.navigation &&
      (!(previous?.visible.some((prior) => key(prior) === key(view)) ?? false) ||
        JSON.stringify(previous?.navigation) !== JSON.stringify(report.navigation))
    )
      yield* runtime
        .lifecycle({
          target,
          event: "context",
          viewId: `${connectionId}:${key(view)}`,
          windowConnectionId: connectionId,
          navigation: report.navigation,
        })
        .pipe(Effect.ignore);
    const active = report.active !== undefined && key(report.active) === key(view);
    const wasActive = previous?.active !== undefined && key(previous.active) === key(view);
    if (active !== wasActive)
      yield* runtime
        .lifecycle({
          target,
          event: active ? "focus" : "blur",
          viewId: `${connectionId}:${key(view)}`,
          windowConnectionId: connectionId,
        })
        .pipe(Effect.ignore);
  }
});

export const invokeGlobalArtifactCommand = Effect.fn("GlobalArtifacts.invoke")(function* (
  command: string,
  input: JsonValue,
  callingSessionId?: string,
  windowConnectionId?: number,
) {
  if (!handlesGlobalArtifactCommand(command))
    return yield* new ArtifactRuntimeError({
      operation: "invoke",
      message: `Unknown artifact operation: ${command}`,
    });
  if (command === "artifacts.globals") {
    const parsed = yield* Schema.decodeUnknownEffect(AgentListInput)(input);
    const page = yield* workflows.searchGlobalLineages({
      search: parsed.query,
      global: true,
      offset: parsed.offset,
      limit: parsed.limit ?? 20,
    });
    return toJsonValue({
      artifacts: page.items,
      total: page.total,
      offset: page.offset,
      nextOffset: page.hasMore ? page.offset + page.items.length : null,
    });
  }
  if (command === "artifacts.viewing") {
    const window =
      windowConnectionId ??
      (callingSessionId === undefined
        ? undefined
        : yield* (yield* RendererRequestCoordinator).connectionForSession(callingSessionId));
    return toJsonValue(yield* (yield* ArtifactViews).read(window));
  }
  if (command === "artifacts.set-global") {
    const parsed = yield* Schema.decodeUnknownEffect(ArtifactSetGlobalInput)(input);
    const result = yield* workflows.setArtifactGlobal(parsed.lineageId, parsed.global);
    (yield* ClientEvents).broadcast({
      type: "artifact-catalog-invalidated",
      lineageId: parsed.lineageId,
    });
    return toJsonValue(result);
  }
  if (command === "artifacts.call")
    return toJsonValue(
      yield* callTool(
        yield* Schema.decodeUnknownEffect(ArtifactToolCallInput)(input),
        callingSessionId,
        windowConnectionId,
      ),
    );
  if (command === "artifacts.runtime.publish")
    return toJsonValue(
      yield* publishRuntime(
        yield* Schema.decodeUnknownEffect(ArtifactRuntimePublishInput)(input),
        callingSessionId,
      ),
    );
  if (command === "artifacts.schedules.configure") {
    const parsed = yield* Schema.decodeUnknownEffect(ArtifactScheduleConfigureInput)(input);
    const target = yield* requireRuntime(parsed.lineageId);
    const tools = yield* (yield* ArtifactRuntime).listTools(target);
    if (!tools.some((tool) => tool.name === parsed.handler))
      return yield* new ArtifactRuntimeError({
        operation: "schedule",
        message: `Unknown artifact handler: ${parsed.handler}`,
      });
    return toJsonValue(yield* schedules.configureArtifactSchedule(parsed));
  }
  if (command === "artifacts.schedules.remove") {
    yield* schedules.removeArtifactSchedule(
      yield* Schema.decodeUnknownEffect(ArtifactScheduleIdentity)(input),
    );
    return { removed: true };
  }
  const { lineageId } = yield* Schema.decodeUnknownEffect(ArtifactIdentityInput)(input);
  if (command === "artifacts.delete") {
    yield* deleteArtifact(lineageId);
    return { deleted: true };
  }
  if (command === "artifacts.schedules.list")
    return toJsonValue(yield* schedules.listArtifactSchedules(lineageId));
  if (command === "artifacts.tools") {
    const revision = yield* current(lineageId);
    const target = yield* resolveRuntimeTarget(lineageId);
    return toJsonValue({
      lineageId,
      revision: revision.metadata.revision,
      tools: target ? yield* (yield* ArtifactRuntime).listTools(target) : [],
    });
  }
  if (command === "artifacts.inspect")
    return toJsonValue({
      artifact: (yield* workflows.lineageDetail(lineageId)).lineage,
      execution: yield* executionStatus(lineageId),
    });
  const action = command.slice("artifacts.runtime.".length);
  if (
    action === "status" ||
    action === "start" ||
    action === "pause" ||
    action === "resume" ||
    action === "restart"
  )
    return toJsonValue(
      yield* controlRuntime(lineageId, action, callingSessionId, windowConnectionId),
    );
  return yield* new ArtifactRuntimeError({
    operation: "invoke",
    message: `Unsupported artifact operation: ${command}`,
  });
});
