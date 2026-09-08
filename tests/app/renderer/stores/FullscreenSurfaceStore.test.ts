import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { FullscreenSurfaceStore } from "../../../../src/renderer/stores/FullscreenSurfaceStore";

describe("FullscreenSurfaceStore", () => {
  it("coordinates native open state and close requests", () => {
    const setOpen = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const store = mount(createStore(FullscreenSurfaceStore, { setOpen }));

    const close = store.open("surface", onClose);
    store.requestClose("surface");

    expect(setOpen).toHaveBeenCalledWith("surface", true);
    expect(onClose).toHaveBeenCalledOnce();

    close();
    expect(setOpen).toHaveBeenCalledWith("surface", false);
    store[Symbol.dispose]();
  });
});
