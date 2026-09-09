/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { ToastStore } from "../../../src/renderer/stores/ToastStore";

describe("ToastHost", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ToastStore;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    store = mount(createStore(ToastStore));
  });

  afterEach(() => {
    act(() => root.unmount());
    store[Symbol.dispose]();
    container.remove();
  });

  it("explicitly dismisses an actionable error and shows a later matching error", () => {
    const retry = vi.fn();
    act(() => {
      store.show({
        title: "Updates stopped",
        message: "Updates for this view stopped.",
        autoDismiss: false,
        coalesceKey: "observation:catalog",
        action: { label: "Retry", run: retry },
      });
      root.render(<ToastHost store={store} />);
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')
        ?.click();
    });
    expect(container.textContent).not.toContain("Updates stopped");
    expect(retry).not.toHaveBeenCalled();

    act(() => {
      store.show({
        title: "Updates stopped",
        message: "A later failure",
        autoDismiss: false,
        coalesceKey: "observation:catalog",
      });
    });
    expect(container.textContent).toContain("A later failure");
  });

  it("reveals and copies technical details without showing them by default", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const details = [
      "Observer: project-session-catalog:resolved:/cake",
      "Error: Session ID collision: session-1",
      "Session IDs: session-1",
      "Stack / cause:",
      "stack trace",
    ].join("\n");
    act(() => {
      store.show({
        title: "Updates stopped",
        message: "Updates for this view stopped. Retry to reconnect.",
        details,
        autoDismiss: false,
      });
      root.render(<ToastHost store={store} />);
    });

    expect(container.textContent).not.toContain("session-1");
    act(() => {
      container.querySelector<HTMLButtonElement>('button[title="Technical details"]')?.click();
    });
    expect(container.textContent).toContain("project-session-catalog:resolved:/cake");
    expect(container.textContent).toContain("Session IDs: session-1");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button.copy-error-details")?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(details);
  });
});
