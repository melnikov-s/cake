export type SessionSwitchPhase =
  | "start"
  | "lookup-start"
  | "lookup-end"
  | "validation-start"
  | "validation-end"
  | "hydration-start"
  | "hydration-end"
  | "selected"
  | "finished"
  | "failed"
  | "superseded";

/** Opt in from DevTools with performance.mark("cake.session-switch.enabled").
 * Marks contain identities and phases, never transcript text. A PerformanceObserver
 * can consume them without retaining a second application log.
 */
export function beginSessionSwitchMeasurement(
  sessionId: string,
  revision: number,
  source: "navigation" | "project-open",
): (phase: SessionSwitchPhase) => void {
  if (!performance.getEntriesByName("cake.session-switch.enabled", "mark").length) return () => {};
  const startedAt = performance.now();
  const phase = (phase: SessionSwitchPhase) => {
    performance.mark("cake.session-switch", {
      detail: { sessionId, revision, source, phase, elapsedMs: performance.now() - startedAt },
    });
  };
  phase("start");
  return phase;
}
