/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddedEditorPane } from "../../../src/renderer/components/embedded-editor";
import type { EmbeddedEditorStore } from "../../../src/renderer/stores/EmbeddedEditorStore";

function editorStore(overrides: Partial<EmbeddedEditorStore> = {}) {
  return {
    status: "missing",
    statusMessage: undefined,
    error: undefined,
    nativeViewReady: false,
    chatSidebarVisible: true,
    setMeasuredBounds: vi.fn(),
    askCakeToSetUp: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    hide: vi.fn(),
    ...overrides,
  } as unknown as EmbeddedEditorStore;
}

describe("EmbeddedEditorPane", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers Cake setup only when the VS Code server is missing", () => {
    act(() => root.render(<EmbeddedEditorPane store={editorStore()} />));

    expect(container.textContent).toContain("Ask Cake to set this up");
    expect(container.textContent).not.toContain("Back to agent");
  });

  it("shows a normal error and returns to the agent for other launch failures", () => {
    const store = editorStore({ status: "ready", error: "ENOENT: workspace no longer exists" });
    act(() => root.render(<EmbeddedEditorPane store={store} />));

    expect(container.textContent).toContain("VS Code could not open");
    expect(container.textContent).toContain("ENOENT: workspace no longer exists");
    expect(container.textContent).not.toContain("Ask Cake to set this up");

    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Back to agent")
        ?.click(),
    );
    expect(store.hide).toHaveBeenCalledOnce();
  });
});
