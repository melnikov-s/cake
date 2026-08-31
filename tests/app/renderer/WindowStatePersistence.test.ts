import { createStore, mount, snapshot, Store } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../src/renderer/client/RendererClient";
import { WindowStatePersistence } from "../../../src/renderer/WindowStatePersistence";

class PersistedStore extends Store {
  @snapshot draft = "";
  transient = "";
}

afterEach(() => vi.useRealTimers());

describe("WindowStatePersistence", () => {
  it("hydrates once at mount, then saves only later Store snapshots", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const client = { windowState: { save } } as unknown as RendererClient;
    const root = mount(createStore(PersistedStore), {
      snapshot: { state: { draft: "restored" }, children: {} },
    });
    const persistence = new WindowStatePersistence(client, vi.fn());
    persistence.observe(root);

    expect(root.draft).toBe("restored");
    expect(save).not.toHaveBeenCalled();

    root.transient = "not persisted";
    await vi.advanceTimersByTimeAsync(200);
    expect(save).not.toHaveBeenCalled();

    root.draft = "updated";
    await vi.advanceTimersByTimeAsync(200);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ state: { draft: "updated" }, children: {} });

    persistence[Symbol.dispose]();
    root[Symbol.dispose]();
  });

  it("serializes flushes and reports save failures outside the Store tree", async () => {
    const failure = new Error("disk unavailable");
    const reportError = vi.fn();
    const save = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const client = { windowState: { save } } as unknown as RendererClient;
    const root = mount(createStore(PersistedStore));
    const persistence = new WindowStatePersistence(client, reportError);
    persistence.observe(root);

    root.draft = "first";
    await persistence.flush();
    expect(reportError).toHaveBeenCalledWith(failure);

    root.draft = "second";
    await persistence.flush();
    expect(save).toHaveBeenLastCalledWith({ state: { draft: "second" }, children: {} });

    persistence[Symbol.dispose]();
    root[Symbol.dispose]();
  });
});
