import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "../../../../src/ipc/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { BrowserStore } from "../../../../src/renderer/stores/BrowserStore";
import { mountWithClient } from "../mount-with-client";

const ready = {
  sessionId: "session-1",
  url: "http://localhost:3000/",
  title: "Local app",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  inspecting: false,
};

function harness() {
  let mode: "normal" | "vscode" | "draw" | "browser" = "normal";
  const attachments: Attachment[] = [];
  const browser = {
    open: vi.fn(async () => ready),
    state: vi.fn(async () => ready),
    updateBounds: vi.fn(async () => ready),
    navigate: vi.fn(async () => ({ ...ready, url: "http://localhost:5173/" })),
    action: vi.fn(async () => ready),
    inspect: vi.fn(async () => ({ ...ready, inspecting: true })),
  };
  const { root, subject: store } = mountWithClient(
    createStore(BrowserStore, {
      sessionId: () => "session-1",
      presentationMode: () => mode,
      setPresentationMode: (value) => {
        mode = value;
      },
      chatSidebarVisible: () => true,
      chatSidebarWidth: () => 420,
      setChatSidebarWidth: vi.fn(),
      appendAttachment: (attachment) => attachments.push(attachment),
      enterProjectSidebarMode: vi.fn(),
      leaveProjectSidebarMode: vi.fn(),
    }),
    { browser } as unknown as Client,
  );
  return { attachments, browser, root, store, mode: () => mode };
}

describe("BrowserStore", () => {
  it("opens the persistent browser view and reports its native bounds", async () => {
    const { browser, root, store, mode } = harness();

    await store.show();
    store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });

    expect(mode()).toBe("browser");
    expect(browser.open).toHaveBeenCalledWith("session-1", undefined, expect.any(Object));
    expect(browser.updateBounds).toHaveBeenLastCalledWith(
      {
        sessionId: "session-1",
        visible: true,
        x: 280,
        y: 40,
        width: 800,
        height: 600,
      },
      expect.any(Object),
    );

    store.suspend();
    expect(browser.updateBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "session-1", visible: false }),
      expect.any(Object),
    );
    root[Symbol.dispose]();
  });

  it("turns an inspected DOM node into explicit composer context", async () => {
    const { attachments, root, store } = harness();
    await store.show();

    store.receive({
      type: "browser-element-selected",
      sessionId: "session-1",
      url: "http://localhost:3000/settings",
      tagName: "button",
      selector: "#save",
      outerHTML: '<button id="save">Save</button>',
      text: "Save",
    });

    expect(attachments).toEqual([
      {
        kind: "browser",
        name: "button #save",
        url: "http://localhost:3000/settings",
        tagName: "button",
        selector: "#save",
        outerHTML: '<button id="save">Save</button>',
        text: "Save",
      },
    ]);
    root[Symbol.dispose]();
  });
});
