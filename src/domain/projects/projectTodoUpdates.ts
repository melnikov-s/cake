import { Effect, Option, Stream } from "effect";
import { ApplicationState } from "../../services/storage/ApplicationState";
import {
  ProjectTodoReports,
  type ProjectTodoReport,
  type ProjectTodoInitialDescription,
} from "../../services/projects/ProjectTodoReports";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  projectTodoSessionIds,
} from "../../contracts/projects/project-todos";
import type { ApplicationState as State } from "../../contracts/application/application-data";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import {
  summarizeTodoReport,
  summarizeInitialTodoDescription,
  utilityModelSelection,
} from "../utility-work/utilityWork";
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

/** Queued only on creation, never on restore. Skip already-edited/removed items before
 * spending model work, then recheck the same revision in the authoritative transaction. */
export const processInitialDescription = Effect.fn("ProjectTodoUpdates.processInitialDescription")(
  function* (request: ProjectTodoInitialDescription) {
    const application = yield* ApplicationState;
    const state = application.snapshot();
    const model = state.utilityModel;
    const item = lists(state)
      .find(({ scope }) => scope === request.scope)
      ?.value.items.find((item) => item.id === request.id);
    if (
      !model ||
      !request.brief.trim() ||
      !item ||
      item.state !== "open" ||
      item.revision !== request.revision
    )
      return;
    const description = yield* summarizeInitialTodoDescription({
      selection: utilityModelSelection(model),
      title: item.title,
      brief: request.brief,
    });
    if (description !== item.description)
      yield* todos.applyReportDescription(request.scope, item, description);
  },
  (effect, request) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Initial to-do summary failed; keeping fallback", error).pipe(
          Effect.annotateLogs({ scope: request.scope, id: request.id }),
        ),
      ),
    ),
);

export const initialize = Effect.fn("ProjectTodoUpdates.initialize")(function* () {
  const reports = yield* ProjectTodoReports;
  yield* reports.reports().pipe(Stream.runForEach(processReports), Effect.forkScoped);
  yield* reports
    .initialDescriptions()
    .pipe(Stream.runForEach(processInitialDescription), Effect.forkScoped);
});
