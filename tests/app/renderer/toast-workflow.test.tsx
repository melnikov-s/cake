/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { applyCakeChatLookup } from "../../../src/renderer/reducers/CatalogReducer";
import { fixtureTimestamp, projectRecord } from "./fixtures/catalog-fixtures";
import { ToastStore, type ToastInput } from "../../../src/renderer/stores/ToastStore";
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
  it.each(["info", "warning", "error"] as const)(
    "uses the opaque floating surface and paired foreground for %s notifications",
    (tone) => {
      using fixture = renderToasts([{ tone, title: "Notification", message: "Readable message" }]);
      void fixture;
      const toast = screen.getByRole(tone === "error" ? "alert" : "status");
      expect(toast.classList.contains("bg-popover")).toBe(true);
      expect(toast.classList.contains("text-popover-foreground")).toBe(true);
    },
  );
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

  it("pauses for pointer or keyboard focus and gives the toast a fresh reading interval after both leave", () => {
    vi.useFakeTimers();
    using fixture = renderToasts([
      {
        tone: "error",
        title: "Updates stopped",
        message: "Updates for this view stopped.",
        details: "Stream disconnected",
        action: { label: "Retry", run: vi.fn() },
        coalesceKey: "observation:catalog",
      },
    ]);
    const toast = screen.getByRole("alert");
    const details = screen.getByRole("button", { name: "Technical details" });
    act(() => vi.advanceTimersByTime(19_999));
    fireEvent.pointerOver(toast);
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole("alert")).toBe(toast);

    act(() => details.focus());
    fireEvent.click(details);
    fireEvent.pointerOut(toast, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByText("Stream disconnected")).toBeDefined();
    expect(document.activeElement).toBe(details);

    // Coalescing in place must preserve focus and the pause.
    fixture.deliver({
      tone: "error",
      title: "Updates stopped",
      message: "A later failure",
      details: "Still disconnected",
      coalesceKey: "observation:catalog",
    });
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByText("Still disconnected")).toBeDefined();
    expect(document.activeElement).toBe(details);
    act(() => details.blur());
    act(() => vi.advanceTimersByTime(19_999));
    expect(screen.getByRole("alert")).toBe(toast);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("expires a failed chat-open toast and can still Retry a later failure before expiry", async () => {
    vi.useFakeTimers();
    const projectPath = "/project";
    const sessionId = `project-chat:${"a".repeat(64)}`;
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: projectPath })],
    });
    const { root } = fixture;
    const view = render(<ToastHost store={root.toastStore} />);
    using _view = { [Symbol.dispose]: () => view.unmount() };

    const open = () => act(() => root.navigationStore.openProjectChat(projectPath));
    // A loaded catalog without this Project Chat fails the open.
    act(() => applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] }));
    await open();
    expect(screen.getByText("Could not open Project Chat")).toBeDefined();
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.queryByText("Could not open Project Chat")).toBeNull();

    await open();
    act(() => {
      applyCakeChatLookup(fixture.models.cakeChatCatalog, {
        sessionId,
        projectPath,
        title: "Project Chat",
        createdAt: fixtureTimestamp,
        modifiedAt: fixtureTimestamp,
        messageCount: 0,
        unstarted: true,
        resolved: false,
        unread: false,
        running: false,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(root.appShellStore.activeConversation?.sessionId).toBe(sessionId);
    expect(screen.queryByText("Could not open Project Chat")).toBeNull();
  });

  // The rail lists projects from their own projection, which can arrive before the
  // chat catalog's first snapshot; a click in between showed "Could not open Project Chat".
  it("opens a Project Chat requested before the chat catalog's first snapshot", async () => {
    const projectPath = "/project";
    const sessionId = `project-chat:${"a".repeat(64)}`;
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: projectPath })],
    });
    const { root } = fixture;
    const view = render(<ToastHost store={root.toastStore} />);
    using _view = { [Symbol.dispose]: () => view.unmount() };

    let opened: Promise<boolean> | undefined;
    act(() => {
      opened = root.navigationStore.openProjectChat(projectPath);
    });
    await act(async () => {
      applySnapshot(fixture.models.cakeChatCatalog, {
        loaded: true,
        sessions: [
          {
            sessionId,
            projectPath,
            title: "Project Chat",
            createdAt: fixtureTimestamp,
            modifiedAt: fixtureTimestamp,
            messageCount: 0,
            resolved: false,
            unread: false,
          },
        ],
      });
      expect(await opened).toBe(true);
    });
    expect(root.appShellStore.activeConversation?.sessionId).toBe(sessionId);
    expect(screen.queryByText("Could not open Project Chat")).toBeNull();
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

  it("clears timers on manual dismissal, replacement, overflow, and Store disposal", () => {
    vi.useFakeTimers();
    const store = mount(createStore(ToastStore, {}));
    try {
      const view = render(<ToastHost store={store} />);
      using _view = { [Symbol.dispose]: () => view.unmount() };
      act(() => store.show({ title: "Build", message: "First", coalesceKey: "build" }));
      act(() => store.show({ title: "Build", message: "Replacement", coalesceKey: "build" }));
      expect(vi.getTimerCount()).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        for (let i = 0; i < 5; i++) store.show({ title: "Build", message: String(i) });
      });
      expect(vi.getTimerCount()).toBe(4);
    } finally {
      store[Symbol.dispose]();
    }
    expect(vi.getTimerCount()).toBe(0);
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
