import { batch, updateStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { BrowserStateSnapshot, Client } from "../../../../src/renderer/client/Client";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const ready: BrowserStateSnapshot = {
  sessionId: "session-1",
  url: "http://localhost:3000/",
  title: "Local app",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  inspecting: false,
};

function harness(browserHost = false) {
  const browser = {
    open: vi.fn<Client["browser"]["open"]>(async () => ready),
    state: vi.fn<Client["browser"]["state"]>(async () => ready),
    updateBounds: vi.fn<Client["browser"]["updateBounds"]>(async () => ready),
    navigate: vi.fn<Client["browser"]["navigate"]>(async () => ({
      ...ready,
      url: "http://localhost:5173/",
    })),
  };
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/tmp/project", name: "Project" })],
    sessions: ["session-1", "session-2"].map((sessionId) =>
      sessionSummary({ sessionId, projectPath: "/tmp/project" }),
    ),
    client: {
      browser,
      terminals: {
        open: async () => ({ terminalId: "terminal-1", shell: "zsh" }),
        close: async () => undefined,
      },
    },
  });
  updateStore(fixture.root, { browserHost });
  for (const sessionId of ["session-1", "session-2"])
    fixture.root.sessionRegistry.load(sessionId, "/tmp/project");
  fixture.root.navigationStore.showLoadedProjectSession("session-1");
  return {
    ...fixture,
    browser,
    store: fixture.root.projectWorkbenchStore.presentationStore.browserStore,
  };
}

// Native boundary backlog, not React workflow proof. The real Root supplies session
// selection/presentation, sidebar policy, terminal inset and retirement collaborators;
// only typed browser/terminal service boundaries are faked. Measurements enter through
// the production measurement API and are not presented as native layout verification.
// browser-workflow owns visible navigation/inspection/retry; terminal-workflow owns panel
// actions. Electron browser.smoke proves real terminal clearance, docking and hidden-view
// session switching, but not these exact batched-ownership and full-occlusion regressions.
// Browser-host rejection is unwired from visible controls; integration/browser-mode-unavailable
// proves control gating, not restored/agent-originated browser requests.
describe("BrowserStore native presentation boundaries", () => {
  it("keeps browser-host opens and restored presentation out of native Browser Mode", async () => {
    using fixture = harness(true);
    const { browser, root, store } = fixture;
    const session = root.sessionRegistry.findSession("session-1")!;
    await store.show();
    expect(session.presentationMode).toBe("normal");
    expect(store.visible).toBe(false);
    expect(root.toastStore.toasts).toEqual([
      expect.objectContaining({
        title: "Browser Mode is desktop-only",
        message: "Open Cake desktop to use Browser Mode.",
      }),
    ]);

    session.showPresentation("browser");
    await store.restore();
    expect(session.presentationMode).toBe("normal");
    expect(store.visible).toBe(false);
    store.showAgentBrowser();
    expect(session.presentationMode).toBe("normal");
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.state).not.toHaveBeenCalled();
    expect(browser.updateBounds).not.toHaveBeenCalled();
  });

  it("reports positive measured native bounds and hides them when suspended", async () => {
    using fixture = harness();
    const { browser, store } = fixture;
    await store.show();
    store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });

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
  });

  it.each(["session-2", undefined])(
    "hides the opened view when batched navigation selects %s, then restores it",
    async (nextSessionId) => {
      using fixture = harness();
      const { browser, root, store } = fixture;
      await store.show();
      store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });
      browser.updateBounds.mockClear();

      // Hydrated-session navigation changes selection before suspending in one batch.
      batch(() => {
        if (nextSessionId) root.navigationStore.selectProjectSession(nextSessionId);
        else root.appShellStore.showWorkbench();
        root.projectWorkbenchStore.presentationStore.suspend();
        store.setMeasuredBounds(undefined);
      });
      expect(browser.updateBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "session-1", visible: false }),
        expect.any(Object),
      );
      expect(browser.updateBounds).toHaveBeenCalledOnce();

      root.navigationStore.selectProjectSession("session-1");
      await store.restore();
      store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });
      expect(browser.updateBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "session-1", visible: true }),
        expect.any(Object),
      );
    },
  );

  it("does not hide the browser when its owning session remains selected", async () => {
    using fixture = harness();
    const { browser, root, store } = fixture;
    await store.show();
    store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });
    browser.updateBounds.mockClear();
    root.navigationStore.selectProjectSession("session-1");
    expect(store.nativeViewBounds.visible).toBe(true);
    expect(browser.updateBounds).not.toHaveBeenCalled();
  });

  it("clears the floating terminal region without reopening or navigating the browser", async () => {
    using fixture = harness();
    const { browser, root, store } = fixture;
    const terminal = root.terminalStore;
    const assertBounds = (y: number, height: number, visible = true) =>
      expect(browser.updateBounds).toHaveBeenLastCalledWith(
        { sessionId: "session-1", visible, x: 280, y, width: 800, height },
        expect.any(Object),
      );

    await store.show();
    store.setMeasuredBounds({ x: 280, y: 40, width: 800, height: 600 });
    terminal.setMeasuredOverlayHeight(365);
    assertBounds(40, 600); // Closed panels leave the browser unchanged.
    terminal.readyForEvents();
    await terminal.toggle();
    assertBounds(365, 275);
    terminal.setMeasuredOverlayHeight(413);
    assertBounds(413, 227);
    terminal.dock();
    assertBounds(40, 600); // Docked layout supplies the measured viewport.
    terminal.moveToTop();
    assertBounds(413, 227);
    terminal.hide();
    assertBounds(40, 600);
    await terminal.toggle();
    terminal.setMeasuredOverlayHeight(0);
    assertBounds(40, 600); // Unmounted panels clear transient geometry.
    terminal.setMeasuredOverlayHeight(30);
    assertBounds(40, 600); // No adjustment when the viewport is already below it.
    terminal.setMeasuredOverlayHeight(900);
    assertBounds(640, 0, false);
    terminal.hide();
    assertBounds(40, 600);
    expect(store.visible).toBe(true);
    expect(store.url).toBe(ready.url);
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(browser.navigate).not.toHaveBeenCalled();
  });
});
