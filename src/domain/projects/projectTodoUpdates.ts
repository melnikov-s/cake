import { Effect, Option, Semaphore, Stream } from "effect";
import { ApplicationState } from "../../services/storage/ApplicationState";
import {
  ProjectTodoReports,
  type ProjectTodoReport,
} from "../../services/projects/ProjectTodoReports";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  projectTodoSessionIds,
} from "../../contracts/projects/project-todos";
import type { ApplicationState as State } from "../../contracts/application/application-data";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import { rankTodos, summarizeTodoReport, utilityModelSelection } from "../utility-work/utilityWork";
import * as todos from "./projectTodos";

const lists = (state: State) => [
  ...state.projects.map((project) => ({
    scope: project.path,
    value: project.todos ?? emptyProjectTodos(),
  })),
  { scope: CAKE_CHAT_TODO_SCOPE, value: state.cakeChatTodos ?? emptyProjectTodos() },
];

/** Optional only for isolated runtime compositions; production always installs the queue. */
export const offer = Effect.fn("ProjectTodoUpdates.offer")(function* (report: ProjectTodoReport) {
  if (!report.text.trim()) return;
  const queue = yield* Effect.serviceOption(ProjectTodoReports);
  if (Option.isSome(queue)) yield* queue.value.offer(report);
});

/** Serialize reports in arrival order. Current descriptions are read at processing time. */
export const processReports = Effect.fn("ProjectTodoUpdates.processReports")(function* (
  reports: readonly ProjectTodoReport[],
) {
  const application = yield* ApplicationState;
  for (const { scope, value } of lists(application.snapshot())) {
    for (const item of value.items) {
      if (item.state !== "open") continue;
      const matching = reports.filter((report) => {
        if (!report.subagent) return projectTodoSessionIds(item).includes(report.sessionId);
        return item.associations.some((link) => {
          const worker =
            link.kind === "subagent"
              ? link
              : link.kind === "source"
                ? parseSubagentLink(link.ref)
                : undefined;
          return (
            worker?.parentSessionId === report.subagent?.parentSessionId &&
            worker?.handleId === report.subagent?.handleId
          );
        });
      });
      const model = application.snapshot().utilityModel;
      if (!matching.length || !model) continue;
      yield* Effect.gen(function* () {
        const description = yield* summarizeTodoReport({
          selection: utilityModelSelection(model),
          title: item.title,
          description: item.description,
          report: matching
            .map(({ text }) => text.slice(0, 4_000))
            .join("\n\n")
            .slice(-16_000),
        });
        if (description !== item.description)
          yield* todos.applyReportDescription(scope, item, description);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("To-do description update failed; keeping current text", error),
        ),
      );
    }
  }
});

/** One bounded comparison per changed list, never per item or transcript. */
export const rankList = Effect.fn("ProjectTodoUpdates.rankList")(function* (scope: string) {
  const application = yield* ApplicationState;
  const model = application.snapshot().utilityModel;
  const value = yield* todos.list(scope);
  const positions = new Map(value.agentOrder?.map((id, index) => [id, index]));
  const items = value.items
    .filter((item) => item.state === "open")
    .sort(
      (a, b) =>
        (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  // Large lists retain their existing order rather than sending an unbounded prompt.
  if (!model || items.length < 2 || items.length > 50) return;
  const key = todos.rankingKey(value.items);
  const order = yield* rankTodos({ selection: utilityModelSelection(model), items });
  if (JSON.stringify(order) !== JSON.stringify(value.agentOrder))
    yield* todos.applyAgentOrder(scope, key, order);
});

export const initialize = Effect.fn("ProjectTodoUpdates.initialize")(function* () {
  const application = yield* ApplicationState;
  const reports = yield* ProjectTodoReports;
  // Shared permit bounds all automatic to-do utility calls to one at a time.
  const calls = yield* Semaphore.make(1);
  yield* reports.reports().pipe(
    Stream.runForEach((batch) => processReports(batch).pipe(calls.withPermits(1))),
    Effect.forkScoped,
  );
  yield* application.changes().pipe(
    Stream.map(({ state }) => ({
      model: state.utilityModel,
      lists: lists(state).map(({ scope, value }) => ({
        scope,
        key: todos.rankingKey(value.items),
      })),
    })),
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    Stream.debounce("1 second"),
    Stream.mapAccum(
      () => new Map<string, string>(),
      (previous, current) => {
        const next = new Map(
          current.lists.map(({ scope, key }) => [scope, JSON.stringify([current.model, key])]),
        );
        return [
          next,
          current.lists
            .filter(({ scope }) => next.get(scope) !== previous.get(scope))
            .map(({ scope }) => scope),
        ] as const;
      },
    ),
    Stream.runForEach((scope) =>
      rankList(scope).pipe(
        calls.withPermits(1),
        Effect.catch((error) =>
          Effect.logWarning("To-do ranking failed; keeping current order", error).pipe(
            Effect.annotateLogs(
              error._tag === "UtilityWorkOutputError" && error.replyPreview !== undefined
                ? { replyPreview: error.replyPreview }
                : {},
            ),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  );
});
