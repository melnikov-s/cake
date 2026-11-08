/** Dependency-free receipts before Effect and the desktop graph can be imported.
 * Fixed bootstrap boundaries only; no timers, filesystem writes or transcript data.
 */
const boundaries: Record<string, number> = {};
export const bootstrapTiming = {
  mark: (phase: string) => {
    boundaries[phase] = performance.now();
  },
  snapshot: () => ({ ...boundaries }),
};
