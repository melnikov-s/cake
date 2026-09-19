/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawStore } from "../../../src/renderer/stores/DrawStore";

let excalidrawProps: Record<string, unknown> | undefined;
vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "immediately", NEVER: "never" },
  FONT_FAMILY: { Excalifont: 1, Helvetica: 2, Cascadia: 3 },
  ROUNDNESS: { PROPORTIONAL_RADIUS: 2 },
  Excalidraw: (props: Record<string, unknown>) => {
    excalidrawProps = props;
    return <div data-testid="excalidraw" />;
  },
}));

import { DrawCanvas } from "../../../src/renderer/components/draw-canvas";

type LinkHandler = (
  element: { link: string | null },
  event: CustomEvent<{ nativeEvent: MouseEvent }>,
) => void;

const store = {
  agentDrawing: false,
  documentSnapshot: null,
  attachEditor: vi.fn(),
  detachEditor: vi.fn(),
} as unknown as DrawStore;

describe("DrawCanvas links", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    excalidrawProps = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("intercepts a valid Cake source link and preserves its exact range", () => {
    const onOpenSourceLocation = vi.fn();
    act(() =>
      root.render(<DrawCanvas store={store} onOpenSourceLocation={onOpenSourceLocation} />),
    );
    const openLink = excalidrawProps?.onLinkOpen as LinkHandler;
    const event = new CustomEvent("link", {
      cancelable: true,
      detail: { nativeEvent: new MouseEvent("click") },
    });

    openLink(
      {
        link: "https://cake.invalid/draw/source?path=src%2Fapp.ts&line=4&column=2&endLine=9&endColumn=7",
      },
      event,
    );

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenSourceLocation).toHaveBeenCalledWith({
      path: "src/app.ts",
      range: {
        start: { line: 3, column: 1 },
        end: { line: 8, column: 6 },
      },
    });
  });

  it("blocks malformed Cake links but leaves ordinary external links to Excalidraw", () => {
    const onOpenSourceLocation = vi.fn();
    act(() =>
      root.render(<DrawCanvas store={store} onOpenSourceLocation={onOpenSourceLocation} />),
    );
    const openLink = excalidrawProps?.onLinkOpen as LinkHandler;
    const malformed = new CustomEvent("link", {
      cancelable: true,
      detail: { nativeEvent: new MouseEvent("click") },
    });
    const external = new CustomEvent("link", {
      cancelable: true,
      detail: { nativeEvent: new MouseEvent("click") },
    });

    openLink({ link: "https://cake.invalid/draw/source?path=../secret.ts" }, malformed);
    openLink({ link: "https://example.com/docs" }, external);

    expect(malformed.defaultPrevented).toBe(true);
    expect(external.defaultPrevented).toBe(false);
    expect(onOpenSourceLocation).not.toHaveBeenCalled();
  });
});
