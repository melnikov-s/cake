import { Effect, Layer } from "effect";
import { ReviewStorage } from "../../../../src/services/storage/ReviewStorage";
import { makeReviewStorageLive } from "../../../../src/services/storage/ReviewStorageLive";

/** Synchronous test-only construction for the in-memory Effect service shell. */
export const makeReviewStorageTestAdapter = (
  root: string,
  piSessionRoot: string,
  loadSession?: Parameters<typeof makeReviewStorageLive>[2],
) => {
  const service = Effect.runSync(
    ReviewStorage.pipe(Effect.provide(makeReviewStorageLive(root, piSessionRoot, loadSession))),
  );
  return { service, paths: service, layer: Layer.succeed(ReviewStorage, service) } as const;
};
