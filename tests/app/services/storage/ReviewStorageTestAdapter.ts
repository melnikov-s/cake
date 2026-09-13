import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Layer } from "effect";
import { makeReviewStorageLive } from "../../../../src/services/storage/ReviewStorageLive";

const TestPlatformLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

export const makeReviewStorageTestAdapter = (
  root: string,
  piSessionRoot: string,
  loadSession?: Parameters<typeof makeReviewStorageLive>[2],
) => makeReviewStorageLive(root, piSessionRoot, loadSession).pipe(Layer.provide(TestPlatformLive));
