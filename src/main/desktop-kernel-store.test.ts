import { Store, createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { mountDesktopKernelStore } from "./desktop-kernel-store";

const cleanup = vi.fn();

class LifecycleProbeStore extends Store {
  constructor(props: ConstructorParameters<typeof Store>[0]) {
    super(props);
    this.effect(() => {
      cleanup();
      return cleanup;
    });
  }
}

describe("main-process Stores", () => {
  it("mounts the desktop kernel root", () => {
    const kernel = mountDesktopKernelStore();
    expect(kernel.process).toBe("main");
    kernel[Symbol.dispose]();
  });

  it("disposes owned effects", () => {
    cleanup.mockClear();
    const store = mount(createStore(LifecycleProbeStore));
    expect(cleanup).toHaveBeenCalledTimes(1);

    store[Symbol.dispose]();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
