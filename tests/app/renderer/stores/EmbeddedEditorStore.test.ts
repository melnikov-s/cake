import { batch } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/contracts/application/application-data";
>>>>>>> 78ca1de9 (test(renderer): consolidate embedded editor workflows with real Root composition)
import type { Client } from "../../../../src/renderer/client/Client";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

function createHarness() {
  const client = {
    getState: vi.fn<Client["vscode"]["getState"]>(async () => ({ status: "missing" })),
    setServerPath: vi.fn<Client["vscode"]["setServerPath"]>(async () => defaultApplicationState()),
    open: vi.fn<Client["vscode"]["open"]>(async () => undefined),
    release: vi.fn<Client["vscode"]["release"]>(async () => undefined),
    reveal: vi.fn<Client["vscode"]["reveal"]>(async () => ({
      outcome: { view: "file" },
      locations: [],
    })),
    updateBounds: vi.fn<Client["vscode"]["updateBounds"]>(async () => undefined),
    updateSelectionHighlights: vi.fn<Client["vscode"]["updateSelectionHighlights"]>(
      async () => undefined,
    ),
    updateAnnotations: vi.fn<Client["vscode"]["updateAnnotations"]>(async () => undefined),
  };
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/tmp/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "session-a", projectPath: "/tmp/project" })],
    client: {
      vscode: client,
      terminals: {
        open: async () => ({ terminalId: "terminal-1", shell: "zsh" }),
        close: async () => undefined,
      },
    },
  });
  fixture.root.sessionRegistry.load("session-a", "/tmp/project");
  fixture.root.navigationStore.showLoadedProjectSession("session-a");
  return {
    ...fixture,
    client,
    store: fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore,
  };
}

const surfaceRect = { x: 292, y: 0, width: 480, height: 820 };
const shownBounds = { visible: true, ...surfaceRect, projectSidebarWidth: 292 };
const hiddenBounds = { visible: false, ...surfaceRect, projectSidebarWidth: 292 };

// Native/transport exceptions, not React or native-layout proof. Root owns all
// session, presentation, sidebar, terminal and retirement collaborators here;
// only typed external Clients are faked. Measurements enter the production API.
// Visible lease/setup/context/annotation/retry workflows are consolidated in
// embedded-editor-workflow.test.tsx. No test-only editor or Store callbacks.
describe("Embedded editor native presentation boundaries", () => {
  it("fits the native editor below a floating terminal and restores it on dock, hide, and unmount", async () => {
    using fixture = createHarness();
    const { client, root, store } = fixture;
    const terminal = root.terminalStore;
    const assertBounds = (y: number, height: number, visible = true) =>
      expect(client.updateBounds).toHaveBeenLastCalledWith(
        { ...shownBounds, y, height, visible },
        expect.any(Object),
      );
    await store.show();
    store.setMeasuredBounds(surfaceRect);
    terminal.setMeasuredOverlayHeight(365);
    assertBounds(0, 820);
    terminal.readyForEvents();
    await terminal.toggle();
    assertBounds(365, 455);
    terminal.setMeasuredOverlayHeight(413);
    assertBounds(413, 407);
    terminal.dock();
    assertBounds(0, 820);
    terminal.moveToTop();
    assertBounds(413, 407);
    terminal.hide();
    assertBounds(0, 820);
    await terminal.toggle();
    terminal.setMeasuredOverlayHeight(0);
    assertBounds(0, 820);
    store.setMeasuredBounds({ ...surfaceRect, y: 450, height: 370 });
    terminal.setMeasuredOverlayHeight(413);
    assertBounds(450, 370);
    terminal.setMeasuredOverlayHeight(900);
    assertBounds(820, 0, false);
    terminal.hide();
    assertBounds(450, 370);
    expect(client.open).toHaveBeenCalledTimes(1);
    expect(client.release).not.toHaveBeenCalled();
  });

  it("resends unchanged native geometry after a disconnected view explicitly reopens", async () => {
    using fixture = createHarness();
    const { client, store } = fixture;
    store.setMeasuredBounds(surfaceRect);
    await store.show();
    store.disconnected();
    expect(client.updateBounds).toHaveBeenLastCalledWith(hiddenBounds, expect.any(Object));
    client.updateBounds.mockClear();
    await store.show();
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));
  });

  it("positions the native view while loading, shows it after opening and hides it on unmount", async () => {
    using fixture = createHarness();
    const { client, store } = fixture;
    let finishOpen!: () => void;
    client.open.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishOpen = () => resolve(undefined))),
    );
    const showing = store.show();
    store.setMeasuredBounds(surfaceRect);
    expect(client.updateBounds).toHaveBeenLastCalledWith(hiddenBounds, expect.any(Object));
    finishOpen();
    await showing;
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));
    store.setMeasuredBounds(undefined);
    expect(client.updateBounds).toHaveBeenLastCalledWith(
      { visible: false, x: 0, y: 0, width: 0, height: 0, projectSidebarWidth: 292 },
      expect.any(Object),
    );
  });

  it("keeps the native view visible when a session switch suspends and restores in one action", async () => {
    using fixture = createHarness();
    const { client, store } = fixture;
    await store.show();
    store.setMeasuredBounds(surfaceRect);
    client.updateBounds.mockClear();
    let restored!: Promise<void>;
    batch(() => {
      store.suspend();
      restored = store.restore();
    });
    await restored;
    const lastBounds = client.updateBounds.mock.calls.at(-1)?.[0];
    if (lastBounds) expect(lastBounds).toEqual(shownBounds);
    client.updateBounds.mockClear();
    store.suspend();
    expect(client.updateBounds).toHaveBeenLastCalledWith(hiddenBounds, expect.any(Object));
    await store.restore();
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));
  });

  // There is no visible simultaneous restore/open control; do not invent one.
  it("shares one in-flight open between a user request and a session restore", async () => {
    using fixture = createHarness();
    const { client, store } = fixture;
    let finishOpen!: () => void;
    client.open.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishOpen = () => resolve(undefined))),
    );
    const shown = store.show();
    const restored = store.restore();
    expect(client.open).toHaveBeenCalledTimes(1);
    finishOpen();
    await Promise.all([shown, restored]);
    expect(client.updateBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: false }),
      expect.any(Object),
    );
    await store.open();
    expect(client.open).toHaveBeenCalledTimes(2);
  });

  // useExistingInstallation has no production caller, including Settings.
  it("keeps the state stream authoritative while changing an unwired server path", async () => {
    using fixture = createHarness();
    const { client, store } = fixture;
    let finish!: () => void;
    client.setServerPath.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(defaultApplicationState()))),
    );
    const request = store.useExistingInstallation("/usr/local/bin/code-server");
    store.applyState({ status: "ready" });
    finish();
    await request;
    expect(store.status).toBe("ready");
    expect(client.setServerPath).toHaveBeenCalledWith(
      "/usr/local/bin/code-server",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.getState).not.toHaveBeenCalled();
  });

  // No visible caller invokes reveal while hidden; source routing enters IDE first.
  it("rejects direct native reveal while hidden without invoking the client", async () => {
    using fixture = createHarness();
    await expect(
      fixture.store.reveal({ kind: "working-directory", path: "src/app.ts" }),
    ).rejects.toThrow("not visible");
    expect(fixture.client.reveal).not.toHaveBeenCalled();
  });

  it("swallows a failed bounds push without surfacing an editor error", async () => {
    using fixture = createHarness();
    const { client, store } = fixture;
    client.updateBounds.mockRejectedValueOnce(new Error("stale"));
    store.setMeasuredBounds(surfaceRect);
    await Promise.resolve();
    expect(client.updateBounds).toHaveBeenCalledWith(hiddenBounds, expect.any(Object));
    expect(store.error).toBeUndefined();
  });
});
