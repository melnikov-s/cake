import { Context, Effect, Layer, Queue, Stream } from "effect";

export interface ProjectTodoInitialDescription {
  readonly scope: string;
  readonly id: string;
  readonly revision: number;
  readonly brief: string;
}

/** Bounded description work, not a second transcript. Producers never wait for models. */
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
    readonly offerInitial: (request: ProjectTodoInitialDescription) => Effect.Effect<void>;
    readonly initialDescriptions: () => Stream.Stream<ProjectTodoInitialDescription>;
  }
>()("cake/services/projects/ProjectTodoReports") {
  static readonly layer = Layer.effect(
    ProjectTodoReports,
    Effect.gen(function* () {
      const queue = yield* Queue.make<ProjectTodoReport>({ capacity: 256, strategy: "dropping" });
      const initial = yield* Queue.make<ProjectTodoInitialDescription>({
        capacity: 256,
        strategy: "dropping",
      });
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      yield* Effect.addFinalizer(() => Queue.shutdown(initial));
      return ProjectTodoReports.of({
        offer: Effect.fn("ProjectTodoReports.offer")(function* (report) {
          if (!(yield* Queue.offer(queue, { ...report, text: report.text.slice(0, 16_000) })))
            yield* Effect.logWarning("To-do report queue full; retaining existing descriptions");
        }),
        reports: () => Stream.fromEffect(Queue.takeAll(queue)).pipe(Stream.forever),
        offerInitial: Effect.fn("ProjectTodoReports.offerInitial")(function* (request) {
          if (!(yield* Queue.offer(initial, { ...request, brief: request.brief.slice(0, 8_000) })))
            yield* Effect.logWarning("Initial to-do summary queue full; retaining fallback", {
              scope: request.scope,
              id: request.id,
            });
        }),
        initialDescriptions: () => Stream.fromQueue(initial),
      });
    }),
  );
}
