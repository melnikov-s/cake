import { Effect, Queue, Stream } from "effect";
import type {
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../../../src/domain/catalog-data";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { unusedCakeChats, unusedDiscussionSessions } from "./unused-cake-session-client";

export interface CatalogTestClient {
  readonly client: CakeIpcClientService;
  readonly projectUpdates: Queue.Queue<ProjectCatalogUpdate>;
  readonly sessionUpdates: Queue.Queue<SessionCatalogUpdate>;
}

export const makeCatalogTestClient = Effect.fn("Test.makeCatalogClient")(function* (options?: {
  readonly projectFinalizer?: Effect.Effect<void>;
  readonly sessionFinalizer?: Effect.Effect<void>;
}) {
  const projectUpdates = yield* Queue.unbounded<ProjectCatalogUpdate>();
  const sessionUpdates = yield* Queue.unbounded<SessionCatalogUpdate>();
  const projectStream = Stream.fromQueue(projectUpdates).pipe(
    Stream.ensuring(options?.projectFinalizer ?? Effect.void),
  );
  const sessionStream = Stream.fromQueue(sessionUpdates).pipe(
    Stream.ensuring(options?.sessionFinalizer ?? Effect.void),
  );
  const client = CakeIpcClient.of({
    application: {
      getHomeDirectory: () => Effect.succeed("/home/user"),
      getState: () => Effect.die("not used"),
    },
    projects: { observeCatalog: () => projectStream },
    models: { list: () => Effect.die("not used") },
    modelPresets: {
      list: () => Effect.die("not used"),
      create: () => Effect.die("not used"),
      update: () => Effect.die("not used"),
      remove: () => Effect.die("not used"),
      setDefault: () => Effect.die("not used"),
      resolve: () => Effect.die("not used"),
    },
    cakeChats: unusedCakeChats,
    discussionSessions: unusedDiscussionSessions,
    projectSessions: {
      list: () => Effect.die("not used"),
      observeCatalog: () => sessionStream,
      inspect: () => Effect.die("not used"),
      create: () => Effect.die("not used"),
      open: () => Effect.die("not used"),
      observe: () => Stream.die("not used"),
      prompt: () => Effect.die("not used"),
      steer: () => Effect.die("not used"),
      followUp: () => Effect.die("not used"),
      abort: () => Effect.die("not used"),
      rename: () => Effect.die("not used"),
      fork: () => Effect.die("not used"),
      resolve: () => Effect.die("not used"),
      restore: () => Effect.die("not used"),
    },
    foundation: {
      typedFailure: () => Effect.void,
      stream: () => Stream.empty,
      delay: () => Effect.void,
      activeRequests: () => Effect.succeed({ delays: 0, streams: 0 }),
    },
  } satisfies CakeIpcClientService);
  return { client, projectUpdates, sessionUpdates };
});
