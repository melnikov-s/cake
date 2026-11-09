import { Cache, Context, Effect, Equal, Hash, Layer, PubSub, Ref, Stream } from "effect";
import type { SessionCatalogUpdate } from "../../contracts/application/catalog-data";
import type {
  ProjectSessionError,
  ProjectSessionSummary,
} from "../../contracts/project-sessions/project-session-data";

export type ProjectCatalogItem =
  | {
      readonly _tag: "InitialBatch";
      readonly sessions: ProjectSessionSummary[];
      readonly hasMore?: boolean;
    }
  | Extract<SessionCatalogUpdate, { _tag: "Event" }>["event"];

/** Equality deliberately excludes the caller's effect: equal queries share one computation. */
class ProjectionRequest implements Equal.Equal {
  constructor(
    readonly key: string,
    readonly compute: Effect.Effect<ReadonlyArray<ProjectCatalogItem>, ProjectSessionError>,
  ) {}
  [Hash.symbol]() {
    return Hash.string(this.key);
  }
  [Equal.symbol](other: Equal.Equal): boolean {
    return other instanceof ProjectionRequest && other.key === this.key;
  }
}

export type SessionCatalogChange =
  | {
      readonly _tag: "ProjectSessionChanged";
      readonly sessionId: string;
      readonly projectPath: string;
      readonly workingDirectory: string;
      readonly resolved: boolean;
    }
  | {
      readonly _tag: "ProjectSessionTitleChanged";
      readonly sessionId: string;
      readonly projectPath: string;
      readonly title: string;
    }
  | {
      readonly _tag: "ProjectSessionActivityChanged";
      readonly sessionId: string;
      readonly projectPath: string;
      readonly workingDirectory: string;
      readonly sessionDirectory: string;
    }
  | {
      readonly _tag: "DiscussionSessionActivityChanged";
      readonly sessionId: string;
      readonly parentSessionId: string;
      readonly workingDirectory: string;
      readonly sessionDirectory: string;
    }
  | {
      readonly _tag: "ProjectSessionRemoved";
      readonly sessionId: string;
      readonly projectPath: string;
    }
  | {
      readonly _tag: "ProjectSessionsTransitioned";
      readonly sessions: ReadonlyArray<{
        readonly sessionId: string;
        readonly workingDirectory: string;
      }>;
      readonly projectPath: string;
      readonly resolved: boolean;
    }
  | {
      readonly _tag: "ProjectSessionStatusChanged";
      readonly sessionId: string;
      readonly projectPath: string;
      readonly workingDirectory: string;
      readonly resolved: boolean;
      readonly unread: boolean;
    }
  | {
      readonly _tag: "CakeChatSessionChanged";
      readonly sessionId: string;
      readonly resolved: boolean;
    }
  | {
      readonly _tag: "CakeChatSessionStatusChanged";
      readonly sessionId: string;
      readonly resolved: boolean;
    }
  | { readonly _tag: "CakeChatSessionRemoved"; readonly sessionId: string };

export class SessionCatalogChanges extends Context.Service<
  SessionCatalogChanges,
  {
    readonly publish: (change: SessionCatalogChange) => Effect.Effect<void>;
    /** Subscribes before consuming the finite initial scan, so mutations cannot fall in a gap. */
    readonly initialThenChanges: <A, E, R>(
      initial: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A | SessionCatalogChange, E, R>;
    /** Per-publication, bounded memoization, never a cross-change status cache. */
    readonly initialThenProjectChanges: <R>(
      initial: Stream.Stream<ProjectCatalogItem, ProjectSessionError, R>,
      key: string,
      project: (
        change: SessionCatalogChange,
      ) => Effect.Effect<ReadonlyArray<ProjectCatalogItem>, ProjectSessionError, R>,
    ) => Stream.Stream<ProjectCatalogItem, ProjectSessionError, R>;
  }
>()("cake/services/session-catalogs/SessionCatalogChanges") {
  static readonly layer = Layer.effect(
    SessionCatalogChanges,
    Effect.gen(function* () {
      const revision = yield* Ref.make(0);
      const changes = yield* PubSub.bounded<{
        readonly revision: number;
        readonly change: SessionCatalogChange;
        readonly projections: Cache.Cache<
          ProjectionRequest,
          ReadonlyArray<ProjectCatalogItem>,
          ProjectSessionError
        >;
      }>({ capacity: 1_024 });
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
      return SessionCatalogChanges.of({
        publish: Effect.fn("SessionCatalogChanges.publish")(function* (change) {
          // An envelope lives only as long as its subscribers' pending change.
          // Distinct page limits are bounded too; eviction may repeat work, never reuse stale data.
          const projections = yield* Cache.make({
            capacity: 64,
            lookup: (request: ProjectionRequest) => request.compute,
          });
          const nextRevision = yield* Ref.updateAndGet(revision, (value) => value + 1);
          yield* PubSub.publish(changes, { revision: nextRevision, change, projections });
        }),
        initialThenChanges: (initial) =>
          Stream.unwrap(
            PubSub.subscribe(changes).pipe(
              Effect.map((subscription) =>
                initial.pipe(
                  Stream.concat(
                    Stream.fromSubscription(subscription).pipe(Stream.map(({ change }) => change)),
                  ),
                ),
              ),
            ),
          ),
        initialThenProjectChanges: (initial, key, project) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const services = yield* Effect.context<Effect.Services<ReturnType<typeof project>>>();
              const subscription = yield* PubSub.subscribe(changes);
              let initialRevision = 0;
              return initial.pipe(
                Stream.tap(() =>
                  Ref.get(revision).pipe(
                    Effect.map((value) => {
                      initialRevision = value;
                    }),
                  ),
                ),
                Stream.concat(
                  Stream.fromSubscription(subscription).pipe(
                    Stream.mapEffect(({ revision: changeRevision, change, projections }) => {
                      const compute = project(change).pipe(Effect.provideContext(services));
                      // Another subscriber may have cached this change before our
                      // initial scan finished. Catch up freshly rather than replay an
                      // older projection over a newer initial snapshot. Never drop it:
                      // the initial scan may itself have read a row before that change.
                      return changeRevision <= initialRevision
                        ? compute
                        : Cache.get(projections, new ProjectionRequest(key, compute));
                    }),
                    Stream.flatMap(Stream.fromIterable),
                  ),
                ),
              );
            }),
          ),
      });
    }),
  );
}
