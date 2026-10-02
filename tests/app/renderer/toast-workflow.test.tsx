/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import type { ToastInput } from "../../../src/renderer/stores/ToastStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderToasts(initial: readonly ToastInput[] = []) {
  const rootFixture = createRendererStoreFixture();
  for (const input of initial) rootFixture.root.toastStore.show(input);
  const view = render(<ToastHost store={rootFixture.root.toastStore} />);
  return {
    user: userEvent.setup(),
    // Toast delivery is an external event, not a user action on the host.
    deliver(input: ToastInput) {
      act(() => rootFixture.root.toastStore.show(input));
    },
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toast workflow", () => {
  it("updates a matching notification without duplicating it and restarts its visible lifetime", () => {
    vi.useFakeTimers();
    using fixture = renderToasts([
      { title: "Build", message: "50% complete", coalesceKey: "build" },
    ]);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(4_000));

    fixture.deliver({ title: "Build", message: "75% complete", coalesceKey: "build" });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("75% complete")).toBeDefined();
    expect(screen.queryByText("50% complete")).toBeNull();

    act(() => vi.advanceTimersByTime(7_999));
    expect(screen.getByText("75% complete")).toBeDefined();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a persistent error until dismissed and allows a later matching error", async () => {
    vi.useFakeTimers();
    using fixture = renderToasts([
      {
        tone: "error",
        title: "Updates stopped",
        message: "Updates for this view stopped.",
        autoDismiss: false,
        coalesceKey: "observation:catalog",
      },
    ]);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("alert").textContent).toContain("Updates stopped");
    vi.useRealTimers();

    await fixture.user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).toBeNull();

    fixture.deliver({
      tone: "error",
      title: "Updates stopped",
      message: "A later failure",
      autoDismiss: false,
      coalesceKey: "observation:catalog",
    });
    expect(screen.getByRole("alert").textContent).toContain("A later failure");
  });

  it("reveals technical details on request and copies the full diagnostic text", async () => {
    const details = [
      "Observer: project-session-catalog:resolved:/cake",
      "Error: Session ID collision: session-1",
      "Session IDs: session-1",
      "Stack / cause:",
      "stack trace",
    ].join("\n");
    using fixture = renderToasts([
      {
        title: "Updates stopped",
        message: "Updates for this view stopped. Retry to reconnect.",
        details,
        autoDismiss: false,
      },
    ]);
    expect(screen.queryByText(/Session IDs: session-1/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy full error details" })).toBeNull();

    await fixture.user.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText(/Session IDs: session-1/).textContent).toBe(details);
    await fixture.user.click(screen.getByRole("button", { name: "Copy full error details" }));
    expect(screen.getByRole("button", { name: "Copied full error details" })).toBeDefined();
    expect(await navigator.clipboard.readText()).toBe(details);
  });

  it("limits the visible stack to the four most recent notifications", () => {
    using fixture = renderToasts(
      Array.from({ length: 4 }, (_, index) => ({
        title: `Build ${index + 1}`,
        message: `Project ${index + 1} complete`,
      })),
    );
    expect(screen.getAllByRole("status")).toHaveLength(4);
    expect(screen.getByText("Build 1")).toBeDefined();

    fixture.deliver({ title: "Build 5", message: "Project 5 complete" });
    expect(
      screen.getAllByRole("status").map((notice) => notice.querySelector("strong")?.textContent),
    ).toEqual(["Build 2", "Build 3", "Build 4", "Build 5"]);
    expect(screen.queryByText("Build 1")).toBeNull();
  });
});
