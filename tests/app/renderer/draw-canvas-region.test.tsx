/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawStore } from "../../../src/renderer/stores/DrawStore";

const editorModule = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
});

vi.mock("../../../src/renderer/components/draw-canvas", async () => {
  await editorModule.ready;
  return { DrawCanvas: () => <div data-testid="draw-canvas" /> };
});

import { DrawCanvasRegion } from "../../../src/renderer/components/draw-canvas-region";

function drawStore(overrides: Partial<DrawStore> = {}) {
  return {
    activeBoardId: "board-1",
    documentLoaded: true,
    loading: false,
    error: undefined,
    initialize: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DrawStore;
}

function buttonNamed(container: HTMLElement, name: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === name,
  );
}

describe("DrawCanvasRegion", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("contains a stalled editor load to the canvas and recovers through Retry", async () => {
    act(() => root.render(<DrawCanvasRegion store={drawStore()} />));
    expect(container.textContent).toContain("Loading Cake Draw editor");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The Cake Draw editor took too long to load.",
    );
    expect(container.querySelector('[data-testid="draw-canvas"]')).toBeNull();

    editorModule.release();
    await act(async () => {
      buttonNamed(container, "Retry")!.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('[data-testid="draw-canvas"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers a store retry when the board cannot be opened", () => {
    const store = drawStore({ documentLoaded: false, error: "read unavailable" });
    act(() => root.render(<DrawCanvasRegion store={store} />));

    expect(store.initialize).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("read unavailable");
    act(() => buttonNamed(container, "Retry")!.click());
    expect(store.retry).toHaveBeenCalledTimes(1);
  });

  it("shows board loading inside the canvas region", () => {
    act(() =>
      root.render(<DrawCanvasRegion store={drawStore({ documentLoaded: false, loading: true })} />),
    );
    expect(container.textContent).toContain("Loading board");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
