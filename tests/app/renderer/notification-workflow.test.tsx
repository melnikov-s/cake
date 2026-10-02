/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import type { NotificationStore } from "../../../src/renderer/stores/NotificationStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const source = { sessionId: "session-1", title: "Build monitor" };

function renderNotifications(showNotification: Client["electron"]["showNotification"]) {
  const rootFixture = createRendererStoreFixture({ client: { electron: { showNotification } } });
  const view = render(<ToastHost store={rootFixture.root.toastStore} />);
  return {
    async deliver(input: Parameters<NotificationStore["enqueue"]>[0]) {
      // Incoming agent notifications enter through the real Root-owned delivery policy.
      await act(() => rootFixture.root.notificationStore.enqueue(input));
    },
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

async function advance(milliseconds: number) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Agent notification workflow", () => {
  it("debounces a session burst into its latest native notification and visible toast", async () => {
    const showNotification = vi.fn<Client["electron"]["showNotification"]>(async () => undefined);
    using fixture = renderNotifications(showNotification);

    await fixture.deliver({ title: "Build", body: "25%", level: "warning", source });
    await advance(2_000);
    await fixture.deliver({ title: "Build", body: "75%", level: "info", source });
    await advance(2_999);
    expect(showNotification).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();

    await advance(1);
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      {
        title: "Build · Build monitor",
        body: "75%",
        level: "info",
        id: "cake-agent:session-1",
        groupId: "cake-agent:session-1",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("status").textContent).toContain("Build · Build monitor");
    expect(screen.getByText("75%")).toBeDefined();
    expect(screen.queryByText("25%")).toBeNull();

    await fixture.deliver({ title: "Build", body: "Complete", level: "success", source });
    await advance(3_000);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Complete")).toBeDefined();
    expect(screen.queryByText("75%")).toBeNull();
  });

  it("delivers different sessions independently without one burst delaying another", async () => {
    const showNotification = vi.fn<Client["electron"]["showNotification"]>(async () => undefined);
    using fixture = renderNotifications(showNotification);

    await fixture.deliver({ title: "First", body: "Build complete", level: "success", source });
    await advance(2_000);
    await fixture.deliver({
      title: "Second",
      body: "Deployment failed",
      level: "error",
      source: { sessionId: "session-2", title: "Deploy monitor" },
    });
    await advance(1_000);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("First · Build monitor");
    expect(screen.queryByRole("alert")).toBeNull();

    await advance(2_000);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenLastCalledWith(
      {
        title: "Second · Deploy monitor",
        body: "Deployment failed",
        level: "error",
        id: "cake-agent:session-2",
        groupId: "cake-agent:session-2",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("status").textContent).toContain("Build complete");
    expect(screen.getByRole("alert").textContent).toContain("Deployment failed");
  });

  it("keeps the in-app notification and explains a native delivery failure", async () => {
    const showNotification = vi.fn<Client["electron"]["showNotification"]>(async () => {
      throw new Error("Desktop notifications are unavailable");
    });
    using fixture = renderNotifications(showNotification);

    await fixture.deliver({ title: "Build complete", body: "All checks passed", level: "success" });
    await advance(3_000);

    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      {
        title: "Build complete",
        body: "All checks passed",
        level: "success",
        id: "cake-agent:cake-agent",
        groupId: "cake-agent:cake-agent",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("status").textContent).toContain("All checks passed");
    expect(screen.getByRole("alert").textContent).toContain("Notification failed");
    expect(screen.getByRole("alert").textContent).toContain(
      "Desktop notifications are unavailable",
    );
  });

  it("cancels pending native delivery when its renderer window closes", async () => {
    const showNotification = vi.fn<Client["electron"]["showNotification"]>(async () => undefined);
    {
      using fixture = renderNotifications(showNotification);
      await fixture.deliver({ title: "Build", body: "Done", level: "info", source });
      await advance(2_999);
      expect(showNotification).not.toHaveBeenCalled();
    }
    await advance(60_000);
    expect(showNotification).not.toHaveBeenCalled();
  });
});
