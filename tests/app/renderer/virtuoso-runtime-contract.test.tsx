/**
 * @vitest-environment jsdom
 */
import { createRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { Virtuoso, VirtuosoMockContext, type VirtuosoHandle } from "react-virtuoso";
import { afterEach, expect, it } from "vitest";

afterEach(cleanup);

// Keep the installed virtualizer real: the transcript tests control this boundary
// and cannot detect a stale dependency missing Cake's patched imperative API.
it("exposes index-navigation cancellation on the installed Virtuoso handle", () => {
  const ref = createRef<VirtuosoHandle>();
  render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
      <Virtuoso ref={ref} data={["Message"]} itemContent={(_, message) => message} />
    </VirtuosoMockContext.Provider>,
  );

  expect(ref.current).not.toBeNull();
  expect(ref.current?.cancelScrollToIndex).toBeTypeOf("function");
  expect(() => ref.current!.cancelScrollToIndex()).not.toThrow();
});
