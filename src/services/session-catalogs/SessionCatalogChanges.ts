import { Context, Effect, Layer, PubSub, Stream } from "effect";
export type SessionCatalogChange =
  | {
      readonly _tag: "ManagedWorktreeChanged";
      readonly workingDirectory: string;
    }
  | {
      readonly _tag: "ProjectSessionChanged";
      readonly sessionId: string;
      readonly projectPath: string;
      readonly workingDirectory: string;
      readonly resolved: boolean;
    }
  | { readonly _tag: "ProjectSessionRemoved"; readonly sessionId: string }
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
  }
>()("cake/services/session-catalogs/SessionCatalogChanges") {
  static readonly layer = Layer.effect(
    SessionCatalogChanges,
    Effect.gen(function* () {
      const changes = yield* PubSub.bounded<SessionCatalogChange>({ capacity: 1_024 });
      return SessionCatalogChanges.of({
        publish: Effect.fn("SessionCatalogChanges.publish")((change) =>
          PubSub.publish(changes, change).pipe(Effect.asVoid),
        ),
        initialThenChanges: (initial) =>
          Stream.unwrap(
            PubSub.subscribe(changes).pipe(
              Effect.map((subscription) =>
                initial.pipe(Stream.concat(Stream.fromSubscription(subscription))),
              ),
            ),
          ),
      });
    }),
  );
}
