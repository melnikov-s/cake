import { Cache, Context, Effect, Equal, Hash, Layer, Ref, Stream } from "effect";
import {
  isChangeFeedResync,
  makeChangeFeed,
  type ChangeFeedResync,
} from "../change-feeds/ChangeFeed";
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
      readonly total?: number;
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

/** This subscriber missed changes while it was not reading; re-read authoritative state. */
export type SessionCatalogResync = ChangeFeedResync;

export class SessionCatalogChanges extends Context.Service<
  SessionCatalogChanges,
  {
    /** Never waits for subscribers, so it is safe while holding turn admission. */
    readonly publish: (change: SessionCatalogChange) => Effect.Effect<void>;
    /**
     * Subscribes before consuming the finite initial scan, so mutations cannot fall in a gap.
     * A subscriber that fell behind gets one `Resync` in place of the changes it missed.
     */
    readonly initialThenChanges: <A, E, R>(
      initial: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A | SessionCatalogChange | SessionCatalogResync, E, R>;
    /**
     * Per-publication, bounded memoization, never a cross-change status cache. After falling
     * behind, the subscriber runs `initial` again instead of projecting the changes it missed.
     */
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
      const changes = yield* makeChangeFeed<{
        readonly revision: number;
        readonly change: SessionCatalogChange;
        readonly projections: Cache.Cache<
          ProjectionRequest,
          ReadonlyArray<ProjectCatalogItem>,
          ProjectSessionError
        >;
      }>({ name: "session-catalog", capacity: 1_024 });
      return SessionCatalogChanges.of({
        publish: Effect.fn("SessionCatalogChanges.publish")(function* (change) {
          // An envelope lives only as long as its subscribers' pending change.
          // Distinct page limits are bounded too; eviction may repeat work, never reuse stale data.
          const projections = yield* Cache.make({
            capacity: 64,
            lookup: (request: ProjectionRequest) => request.compute,
          });
          const nextRevision = yield* Ref.updateAndGet(revision, (value) => value + 1);
          yield* changes.publish({ revision: nextRevision, change, projections });
        }),
        initialThenChanges: (initial) =>
          Stream.unwrap(
            changes
              .subscribe()
              .pipe(
                Effect.map((subscription) =>
                  initial.pipe(
                    Stream.concat(
                      subscription.pipe(
                        Stream.map((item) => (isChangeFeedResync(item) ? item : item.change)),
                      ),
                    ),
                  ),
                ),
              ),
          ),
        initialThenProjectChanges: (initial, key, project) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const services = yield* Effect.context<Effect.Services<ReturnType<typeof project>>>();
              const subscription = yield* changes.subscribe();
              let initialRevision = 0;
              const scan = initial.pipe(
                Stream.tap(() =>
                  Ref.get(revision).pipe(
                    Effect.map((value) => {
                      initialRevision = value;
                    }),
                  ),
                ),
              );
              return scan.pipe(
                Stream.concat(
                  subscription.pipe(
                    Stream.flatMap((item) => {
                      if (isChangeFeedResync(item)) return scan;
                      const { revision: changeRevision, change, projections } = item;
                      const compute = project(change).pipe(Effect.provideContext(services));
                      // Another subscriber may have cached this change before our
                      // initial scan finished. Catch up freshly rather than replay an
                      // older projection over a newer initial snapshot. Never drop it:
                      // the initial scan may itself have read a row before that change.
                      return Stream.fromEffect(
                        changeRevision <= initialRevision
                          ? compute
                          : Cache.get(projections, new ProjectionRequest(key, compute)),
                      ).pipe(Stream.flatMap(Stream.fromIterable));
                    }),
                  ),
                ),
              );
            }),
          ),
      });
    }),
  );
}
