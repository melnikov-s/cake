/**
 * @vitest-environment jsdom
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../../../src/renderer/components/renderer-error-boundary";

function CrashedView() {
  useEffect(() => {
    throw new Error("Maximum update depth exceeded");
  }, []);
  return <div>Application content</div>;
}

describe("RendererErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
  });

  it("shows passive-effect crash details and reloads the renderer", () => {
    const onReload = vi.fn();

    act(() => root.render(
      <RendererErrorBoundary onReload={onReload}>
        <CrashedView />
      </RendererErrorBoundary>
    ));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The renderer crashed");
    expect(container.querySelector("pre")?.textContent).toContain("Maximum update depth exceeded");
    expect(container.querySelector("pre")?.textContent).toContain("React component stack");

    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(onReload).toHaveBeenCalledOnce();
  });
});
