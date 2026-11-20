import { Effect, Layer, Stream } from "effect";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { unstubbed } from "./unstubbed";

type Service = CakeSessionRuntimes["Service"];

/** No sessions and no live runtimes. Acquiring or inspecting a session is unstubbed. */
const neutralCakeSessionRuntimes = (): Service => ({
  sessionIds: () => Stream.empty,
  catalog: () => Stream.empty,
  catalogSnapshot: (query) =>
    Effect.succeed({
      directory: query.sessionDirectory,
      workingDirectory: query.workingDirectory,
      shared: false,
      find: () => undefined,
    }),
  catalogEntry: () => Effect.succeed(undefined),
  hasTranscript: () => Effect.succeed(false),
  inspect: () => unstubbed("CakeSessionRuntimes.inspect"),
  acquire: () => unstubbed("CakeSessionRuntimes.acquire"),
  acquireCurrent: () => unstubbed("CakeSessionRuntimes.acquireCurrent"),
  acquireSession: () => unstubbed("CakeSessionRuntimes.acquireSession"),
  hasCurrent: () => Effect.succeed(false),
  currentStatus: () => Effect.succeed(undefined),
  activeWorkingDirectories: () => Effect.succeed([]),
  currentModifiedAt: () => Effect.succeed(undefined),
  currentTurnIds: () => Effect.succeed([]),
  executingTurnIds: () => Effect.succeed([]),
  turnSettlement: () => Effect.succeed("unknown" as const),
  forgetRecovery: () => Effect.void,
  refreshModels: () => Effect.void,
  reloadWorkingDirectory: () => Effect.void,
  reloadAll: () => Effect.void,
  reloadCakeChatContext: () => Effect.void,
  durableArtifactReferences: () => Effect.succeed({ sessionIds: [], lineageIds: [] }),
});

export const fakeCakeSessionRuntimes = (overrides: Partial<Service> = {}) =>
  Layer.succeed(
    CakeSessionRuntimes,
    CakeSessionRuntimes.of({ ...neutralCakeSessionRuntimes(), ...overrides }),
  );
