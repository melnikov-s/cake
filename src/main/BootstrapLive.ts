import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const FileSystemAndPathLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const ProcessLive = NodeChildProcessSpawner.layer.pipe(Layer.provide(FileSystemAndPathLive));

const LoggingLive = Logger.layer([Logger.withConsoleLog(Logger.formatLogFmt)]);

/**
 * The platform capabilities needed at the immutable main-process bootstrap
 * boundary. Product services, IPC handlers, and user plugins are deliberately
 * not part of this layer.
 */
export const BootstrapLive = Layer.mergeAll(
  FileSystemAndPathLive,
  FetchHttpClient.layer,
  ProcessLive,
  LoggingLive,
);
