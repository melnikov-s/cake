import type { RootProjection } from "../models/RootProjection";
import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";
import { observeApplicationEvents } from "./application-events";
import { observeArtifactEvents } from "./artifact-events";
import { observeSurfaceEvents } from "./surface-events";
import { observeTerminalEvents } from "./terminal-events";
import { observeVsCodeEvents } from "./vscode-events";

/** Observes every fixed native event channel for one renderer window. */
export const observeNativeEvents = (
  runtime: RendererRuntime,
  projection: RootProjection,
  root: RootStore,
) => {
  const stop = [
    observeApplicationEvents(runtime, root),
    observeArtifactEvents(runtime, projection, root),
    observeTerminalEvents(runtime, root),
    observeVsCodeEvents(runtime, root),
    observeSurfaceEvents(runtime, root),
  ];
  return () => {
    for (const cancel of stop) cancel();
  };
};
