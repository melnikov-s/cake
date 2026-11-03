/**
 * Shares one result between callers for `windowMs` after the load starts, including callers
 * that arrive while it is still running. A failed load is never reused.
 */
export function reuseRecent<A>(
  windowMs: number,
  load: () => Promise<A>,
  now: () => number = Date.now,
): () => Promise<A> {
  let recent: { readonly startedAt: number; readonly result: Promise<A> } | undefined;
  return () => {
    if (recent && now() - recent.startedAt < windowMs) return recent.result;
    const entry = { startedAt: now(), result: load() };
    recent = entry;
    entry.result.catch(() => {
      if (recent === entry) recent = undefined;
    });
    return entry.result;
  };
}
