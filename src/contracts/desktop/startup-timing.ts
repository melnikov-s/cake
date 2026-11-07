import { Schema } from "effect";

export const STARTUP_TIMING_PREFIX = "[cake.startup] ";
export const RendererStartupPhase = Schema.Literals([
  "renderer-entry",
  "window-state-load-start",
  "window-state-load-end",
  "window-state-hydrated",
  "navigation-restore-start",
  "navigation-restore-end",
  "navigation-restore-failed",
  "render-scheduled",
  "first-commit",
  "selected-chat-projection-commit",
  "selected-chat-changed",
]);
export type RendererStartupPhase = typeof RendererStartupPhase.Type;

/** No identities, transcript data, paths or error bodies cross this diagnostic boundary. */
export const RendererStartupTiming = Schema.Struct({
  phase: RendererStartupPhase,
  rendererElapsedMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export interface RendererStartupTiming extends Schema.Schema.Type<typeof RendererStartupTiming> {}
