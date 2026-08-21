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
