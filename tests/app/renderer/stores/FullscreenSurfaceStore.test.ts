import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { FullscreenSurfaceStore } from "../../../../src/renderer/stores/FullscreenSurfaceStore";

// Migration backlog: session-layout-workflow proves native setOpen true/false
// through the real continuation dialog. Browser/Mermaid Electron workflows prove
// native visibility and Escape stacking, but not a targeted host close request
// through observeSurfaceEvents. Retain only the registered-callback policy here;
// this direct test is not proof of the native event stream or observer routing.
describe("FullscreenSurfaceStore remaining contract", () => {
  it("routes a close request to the registered surface callback", () => {
    const onClose = vi.fn();
    const store = mount(createStore(FullscreenSurfaceStore));

    const close = store.open("surface", onClose);
    store.requestClose("surface");

    expect(onClose).toHaveBeenCalledOnce();

    close();
    store[Symbol.dispose]();
  });
});
