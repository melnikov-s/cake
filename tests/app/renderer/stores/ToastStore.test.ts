import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastStore } from "../../../../src/renderer/stores/ToastStore";

describe("ToastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a toast with a default info tone", () => {
    const store = mount(createStore(ToastStore));
    store.show({ title: "Hello", message: "World" });

    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0]).toMatchObject({ tone: "info", title: "Hello", message: "World" });
    store[Symbol.dispose]();
  });

  it("coalesces matching agent notifications and refreshes their timeout", () => {
    const store = mount(createStore(ToastStore));
    store.show({ title: "Build", message: "50%", coalesceKey: "build" });
    vi.advanceTimersByTime(4_000);
    store.show({ title: "Build", message: "50%", coalesceKey: "build" });

    expect(store.toasts).toHaveLength(1);
    vi.advanceTimersByTime(4_001);
    expect(store.toasts).toHaveLength(1);
    vi.advanceTimersByTime(3_999);
    expect(store.toasts).toHaveLength(0);
    store[Symbol.dispose]();
  });

  it("runs an optional action and dismisses the toast", () => {
    const store = mount(createStore(ToastStore));
    const run = vi.fn();
    store.show({ title: "Created", message: "Draft", action: { label: "View", run } });

    store.runAction(store.toasts[0]!.id);

    expect(run).toHaveBeenCalledOnce();
    expect(store.toasts).toHaveLength(0);
    store[Symbol.dispose]();
  });

  it("auto-dismisses a toast after the timeout", () => {
    const store = mount(createStore(ToastStore));
    store.show({ title: "Hello", message: "World" });

    vi.advanceTimersByTime(7_999);
    expect(store.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.toasts).toHaveLength(0);
    store[Symbol.dispose]();
  });

  it("dismisses on demand and clears pending timers", () => {
    const store = mount(createStore(ToastStore));
    store.show({ title: "Hello", message: "World" });
    const id = store.toasts[0]!.id;

    store.dismiss(id);
    expect(store.toasts).toHaveLength(0);

    vi.advanceTimersByTime(60_000);
    expect(store.toasts).toHaveLength(0);
    store[Symbol.dispose]();
  });

  it("caps the stack by dropping the oldest toast", () => {
    const store = mount(createStore(ToastStore));
    for (let index = 0; index < 5; index += 1)
      store.show({ title: `Toast ${index}`, message: String(index) });

    expect(store.toasts.map((toast) => toast.title)).toEqual([
      "Toast 1",
      "Toast 2",
      "Toast 3",
      "Toast 4",
    ]);
    store[Symbol.dispose]();
  });
});
