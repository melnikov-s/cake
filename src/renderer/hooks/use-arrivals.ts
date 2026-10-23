import { useLayoutEffect, useRef } from "react";

/** More simultaneous newcomers than this is hydration or a history page, not live arrival. */
const ARRIVAL_BURST_LIMIT = 4;
/** Outlasts every entrance animation, so a late (virtualized) mount still animates. */
const ARRIVAL_WINDOW_MS = 600;

/** Keys in `next` that are absent from `previous`, or none when the change is a bulk load. */
export function arrivedKeys(
  previous: ReadonlySet<string>,
  next: Iterable<string>,
  limit = ARRIVAL_BURST_LIMIT,
): string[] {
  const fresh: string[] = [];
  for (const key of next) {
    if (previous.has(key)) continue;
    fresh.push(key);
    if (fresh.length > limit) return [];
  }
  return fresh;
}

interface ArrivalState {
  scope: string | undefined;
  /** Keys of the last commit; undefined until the first commit establishes a baseline. */
  committed: ReadonlySet<string> | undefined;
  arrivals: Map<string, number>;
}

/**
 * Identifies keys that joined a live collection after its first commit. Items mounted
 * by virtualization or a remount are not arrivals; only recent additions are. Changing
 * `scope` (e.g. switching conversations) re-establishes the baseline.
 */
export function useArrivals(keys: readonly string[], scope?: string): (key: string) => boolean {
  const state = useRef<ArrivalState | null>(null);
  if (!state.current || state.current.scope !== scope)
    state.current = { scope, committed: undefined, arrivals: new Map() };
  const current = state.current;
  // Recorded during render because children mount in this same pass. Idempotent: a
  // discarded render only records a timestamp that the next render would also record.
  if (current.committed) {
    const now = performance.now();
    for (const key of arrivedKeys(current.committed, keys))
      if (!current.arrivals.has(key)) current.arrivals.set(key, now);
  }
  useLayoutEffect(() => {
    current.committed = new Set(keys);
    const expired = performance.now() - ARRIVAL_WINDOW_MS;
    for (const [key, at] of current.arrivals) if (at < expired) current.arrivals.delete(key);
  });
  return (key) => {
    const at = current.arrivals.get(key);
    return at !== undefined && performance.now() - at < ARRIVAL_WINDOW_MS;
  };
}
