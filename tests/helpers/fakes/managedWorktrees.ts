import { Effect, Layer, Stream } from "effect";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { unstubbed } from "./unstubbed";

type Service = ManagedWorktrees["Service"];

/** No managed checkouts: queries find nothing; operations that need a checkout are unstubbed. */
const neutralManagedWorktrees = (): Service => ({
  records: () => Effect.succeed([]),
  observeLandingQueue: () => Stream.never,
  observe: () => Stream.never,
  createCheckout: () => unstubbed("ManagedWorktrees.createCheckout"),
  awaitSetup: () => Effect.void,
  status: () => Effect.succeed(undefined),
  headState: () => Effect.succeed(undefined),
  prepareLanding: () => unstubbed("ManagedWorktrees.prepareLanding"),
  releaseLanding: () => Effect.void,
  setResolveAfterLanding: () => unstubbed("ManagedWorktrees.setResolveAfterLanding"),
  land: () => unstubbed("ManagedWorktrees.land"),
  cancelLanding: () => Effect.void,
  rebase: () => unstubbed("ManagedWorktrees.rebase"),
  discard: () => unstubbed("ManagedWorktrees.discard"),
  cleanupResolved: () => Effect.succeed(false),
  restoreResolved: () => Effect.succeed(undefined),
  proposeSquashMessage: () => Effect.void,
});

export const fakeManagedWorktrees = (overrides: Partial<Service> = {}) =>
  Layer.succeed(
    ManagedWorktrees,
    ManagedWorktrees.of({ ...neutralManagedWorktrees(), ...overrides }),
  );
