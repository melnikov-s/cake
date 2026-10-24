import { Context, Effect, Layer, Queue, Stream } from "effect";

/** A final report, not a second transcript. Producers never wait for model work. */
export interface ProjectTodoReport {
  readonly projectPath?: string;
  readonly sessionId: string;
  readonly subagent?: { readonly parentSessionId: string; readonly handleId: string };
  readonly text: string;
}

export class ProjectTodoReports extends Context.Service<
  ProjectTodoReports,
  {
    readonly offer: (report: ProjectTodoReport) => Effect.Effect<void>;
    readonly reports: () => Stream.Stream<readonly ProjectTodoReport[]>;
  }
>()("cake/services/projects/ProjectTodoReports") {
  static readonly layer = Layer.effect(
    ProjectTodoReports,
    Effect.gen(function* () {
      const queue = yield* Queue.make<ProjectTodoReport>({ capacity: 256, strategy: "dropping" });
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      return ProjectTodoReports.of({
        offer: Effect.fn("ProjectTodoReports.offer")(function* (report) {
          if (!(yield* Queue.offer(queue, { ...report, text: report.text.slice(0, 16_000) })))
            yield* Effect.logWarning("To-do report queue full; retaining existing descriptions");
        }),
        reports: () => Stream.fromEffect(Queue.takeAll(queue)).pipe(Stream.forever),
      });
    }),
  );
}
