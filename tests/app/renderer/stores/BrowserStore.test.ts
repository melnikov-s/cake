import { batch, createStore, observable } from "r-state-tree";
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

function harness(browserHost = false) {
  let mode: "normal" | "vscode" | "draw" | "browser" = "normal";
  const selection = observable({ sessionId: "session-1" as string | undefined });
  const onBrowserUnavailable = vi.fn();
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
      sessionId: () => selection.sessionId,
      browserHost,
      onBrowserUnavailable,
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
  return {
    attachments,
    selection,
    browser,
    root,
    store,
    mode: () => mode,
    onBrowserUnavailable,
    setMode: (value: typeof mode) => {
      mode = value;
    },
  };
}

describe("BrowserStore", () => {
  it("keeps browser-host opens and restored presentation out of native Browser Mode", async () => {
    const { browser, root, store, mode, setMode, onBrowserUnavailable } = harness(true);
    await store.show();
    expect(mode()).toBe("normal");
    expect(store.visible).toBe(false);
    expect(onBrowserUnavailable).toHaveBeenCalledOnce();

    setMode("browser");
    await store.restore();
    expect(mode()).toBe("normal");
    expect(store.visible).toBe(false);
    store.showAgentBrowser();
    expect(mode()).toBe("normal");
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.state).not.toHaveBeenCalled();
    expect(browser.updateBounds).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });
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

  it.each(["session-2", undefined])(
    "hides the opened view when batched navigation selects %s, then restores it",
    async (nextSessionId) => {
      const { browser, root, store, selection } = harness();
      await store.show();
      store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });
      browser.updateBounds.mockClear();

      // Hydrated-session navigation changes selection before suspending in one batch.
      batch(() => {
        selection.sessionId = nextSessionId;
        store.suspend();
        store.setMeasuredBounds(undefined);
      });
      expect(browser.updateBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "session-1", visible: false }),
        expect.any(Object),
      );
      expect(browser.updateBounds).toHaveBeenCalledOnce();

      selection.sessionId = "session-1";
      await store.restore();
      store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });
      expect(browser.updateBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "session-1", visible: true }),
        expect.any(Object),
      );
      root[Symbol.dispose]();
    },
  );

  it("does not hide the browser when its owning session remains selected", async () => {
    const { browser, root, store, selection } = harness();
    await store.show();
    store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });
    browser.updateBounds.mockClear();
    selection.sessionId = "session-1";
    expect(store.nativeViewBounds.visible).toBe(true);
    expect(browser.updateBounds).not.toHaveBeenCalled();
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
        name: "#save",
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
