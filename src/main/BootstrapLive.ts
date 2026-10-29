import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const FileSystemAndPathLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const ProcessLive = NodeChildProcessSpawner.layer.pipe(Layer.provide(FileSystemAndPathLive));

/**
 * The platform capabilities needed at the immutable main-process bootstrap
 * boundary. Product services and IPC handlers are deliberately
 * not part of this layer.
 */
export const BootstrapLive = Layer.mergeAll(
  FileSystemAndPathLive,
  FetchHttpClient.layer,
  ProcessLive,
);
