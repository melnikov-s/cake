import { Schema } from "effect";

export const STARTUP_TIMING_PREFIX = "[cake.startup] ";
export const RendererStartupPhase = Schema.Literals([
  "renderer-entry",
  "window-state-load-start",
  "window-state-load-end",
  "window-state-hydrated",
  "renderer-observers-start",
  "renderer-observers-end",
  "window-persistence-start",
  "window-persistence-end",
  "capture-overlays-setup-start",
  "capture-overlays-setup-end",
  "model-observers-start",
  "model-observers-end",
  "model-provider-hydration-start",
  "model-provider-hydration-scheduled",
  "model-provider-hydration-settled",
  "saved-drafts-observe-start",
  "saved-drafts-initial-received",
  "app-controls-start",
  "app-controls-end",
  "app-controls-failed",
  "cake-chat-catalog-initial-received",
  "cake-chat-projection-observe-start",
  "cake-chat-projection-received",
  "cake-chat-projection-reduced",
  "render-scheduled",
  "first-commit",
  "first-contentful-paint",
  "selected-chat-composer-editable-commit",
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
