import { createStore } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { NotificationStore } from "../../../../src/renderer/stores/NotificationStore";
import { mountWithClient } from "../mount-with-client";

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
    const showToast = vi.fn();
    const { root, subject: store } = mountWithClient(
      createStore(NotificationStore, { onToast: showToast, onError: vi.fn() }),
      { electron: { showNotification } } as unknown as Client,
    );

    await store.enqueue({ title: "Build", body: "25%", level: "warning", source });
    vi.advanceTimersByTime(2_000);
    await store.enqueue({ title: "Build", body: "75%", level: "info", source });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(showNotification).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();

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
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith({
      title: "Build · Build monitor",
      message: "75%",
      tone: "info",
      coalesceKey: "cake-agent:session-1",
    });
    root[Symbol.dispose]();
  });

  it("batches different sessions independently", async () => {
    const showNotification = vi.fn(async () => undefined);
    const showToast = vi.fn();
    const { root, subject: store } = mountWithClient(
      createStore(NotificationStore, { onToast: showToast, onError: vi.fn() }),
      { electron: { showNotification } } as unknown as Client,
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
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "info", coalesceKey: "cake-agent:session-1" }),
    );
    root[Symbol.dispose]();
  });

  it("cancels pending delivery when disposed", async () => {
    const showNotification = vi.fn(async () => undefined);
    const showToast = vi.fn();
    const { root, subject: store } = mountWithClient(
      createStore(NotificationStore, { onToast: showToast, onError: vi.fn() }),
      { electron: { showNotification } } as unknown as Client,
    );

    await store.enqueue({ title: "Build", body: "Done", level: "info", source });
    root[Symbol.dispose]();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(showNotification).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});
