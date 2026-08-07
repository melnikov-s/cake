import { describe, expect, it, vi } from "vitest";
import { Store, createStore, mount } from "r-state-tree";
import { mountDesktopKernelStore, mountWindowStore } from "./index";

class LifecycleProbeStore extends Store {
  constructor(props: ConstructorParameters<typeof Store>[0]) {
    super(props);
    this.effect(() => {
      cleanup();
      return cleanup;
    });
  }
}

const cleanup = vi.fn();

describe("root stores", () => {
  it("mounts process-specific roots", () => {
    const kernel = mountDesktopKernelStore();
    const window = mountWindowStore();

    expect(kernel.process).toBe("main");
    expect(window.process).toBe("renderer");

    kernel[Symbol.dispose]();
    window[Symbol.dispose]();
  });

  it("disposes owned effects", () => {
    cleanup.mockClear();
    const store = mount(createStore(LifecycleProbeStore));
    expect(cleanup).toHaveBeenCalledTimes(1);

    store[Symbol.dispose]();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
