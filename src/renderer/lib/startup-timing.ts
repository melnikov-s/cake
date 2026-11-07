import {
  STARTUP_TIMING_PREFIX,
  type RendererStartupPhase,
} from "../../contracts/desktop/startup-timing";

/** At most one record per known phase per document; never a per-render/message trace. */
export const makeRendererStartupTiming = (
  now: () => number,
  emit: (message: string) => void,
  mark: (name: string) => void,
) => {
  const seen = new Set<RendererStartupPhase>();
  return (phase: RendererStartupPhase) => {
    if (seen.has(phase)) return;
    seen.add(phase);
    const rendererElapsedMs = now();
    mark(`cake.startup.${phase}`);
    emit(STARTUP_TIMING_PREFIX + JSON.stringify({ phase, rendererElapsedMs }));
  };
};

export const rendererStartupTiming = makeRendererStartupTiming(
  () => performance.now(),
  (message) => console.info(message),
  (name) => performance.mark(name),
);
