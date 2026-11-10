import { act } from "@testing-library/react";

/**
 * Virtualized lists make their rows interactive after their first layout frame,
 * and settle rows into reading (DOM) order shortly after updates go idle.
 */
export function settleListLayout() {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
}
