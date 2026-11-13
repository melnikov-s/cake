/** Deterministic allocation from requested sizes and one container measurement.
 * Preferred sizes survive window narrowing; neither rendered peer feeds back into the calculation.
 */
export function allocateWidgetPair(
  available: number,
  first: number,
  second: number,
): [number, number] {
  const extent = Math.max(0, available);
  const a = Math.max(0, first);
  const b = Math.max(0, second);
  const total = a + b;
  if (total <= extent) return [a, b];
  const allocatedFirst = (extent * a) / total;
  return [allocatedFirst, extent - allocatedFirst];
}
