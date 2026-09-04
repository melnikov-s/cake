import { createStore } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { NotificationStore } from "../../../../src/renderer/stores/NotificationStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

const source = {
  kind: "project-session" as const,
  sessionId: "session-1",
  title: "Build monitor",
};

describe("NotificationStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a session burst and delivers only its latest notification", async () => {
    const showNotification = vi.fn(async () => undefined);
    const { root, subject: store } = mountWithRendererClient(
      createStore(NotificationStore, { onError: vi.fn() }),
      { electron: { showNotification } } as unknown as RendererClient,
    );

    await store.enqueue({ title: "Build", body: "25%", level: "warning", source });
    vi.advanceTimersByTime(2_000);
    await store.enqueue({ title: "Build", body: "75%", level: "info", source });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(showNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith(
      {
        title: "Build · Build monitor",
        body: "75%",
        level: "info",
        id: "cake-agent:session-1",
        groupId: "cake-agent:session-1",
      },
      { signal: store.signal },
    );
    root[Symbol.dispose]();
  });

  it("batches different sessions independently", async () => {
    const showNotification = vi.fn(async () => undefined);
    const { root, subject: store } = mountWithRendererClient(
      createStore(NotificationStore, { onError: vi.fn() }),
      { electron: { showNotification } } as unknown as RendererClient,
    );

    await store.enqueue({ title: "First", body: "Done", level: "success", source });
    await store.enqueue({
      title: "Second",
      body: "Done",
      level: "error",
      source: { ...source, sessionId: "session-2" },
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(showNotification).toHaveBeenCalledTimes(2);
    root[Symbol.dispose]();
  });

  it("cancels pending delivery when disposed", async () => {
    const showNotification = vi.fn(async () => undefined);
    const { root, subject: store } = mountWithRendererClient(
      createStore(NotificationStore, { onError: vi.fn() }),
      { electron: { showNotification } } as unknown as RendererClient,
    );

    await store.enqueue({ title: "Build", body: "Done", level: "info", source });
    root[Symbol.dispose]();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(showNotification).not.toHaveBeenCalled();
  });
});
