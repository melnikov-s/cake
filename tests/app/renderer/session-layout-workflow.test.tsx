/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [
      {
        id: "assistant-entry",
        type: "message",
        messageRole: "assistant",
        preview: "Finished work",
        active: true,
      },
    ],
  };
}
function renderLayout(restoredRatio?: number) {
  const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
  const setFullscreenSurfaceOpen = vi.fn<Client["electron"]["setFullscreenSurfaceOpen"]>(
    async () => undefined,
  );
  const fixture = createRendererStoreFixture({
    snapshot:
      restoredRatio === undefined
        ? undefined
        : {
            state: {},
            children: {
              sessionLayoutStore: {
                state: {
                  focusedPaneId: "left-pane",
                  layout: {
                    kind: "split",
                    splitId: "saved-split",
                    axis: "x",
                    ratio: restoredRatio,
                    first: {
                      kind: "pane",
                      paneId: "left-pane",
                      history: ["alpha"],
                      historyCursor: 0,
                    },
                    second: {
                      kind: "pane",
                      paneId: "right-pane",
                      history: ["beta"],
                      historyCursor: 0,
                    },
                  },
                },
                children: {},
              },
            },
          },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: ["alpha", "beta", "gamma"].map((sessionId) =>
      sessionSummary({ sessionId, title: `${sessionId} conversation`, projectPath: "/project" }),
    ),
    client: {
      projectSessions: { open },
      electron: { setFullscreenSurfaceOpen },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  for (const id of ["alpha", "beta", "gamma"]) {
    fixture.root.sessionRegistry.load(id, "/project");
    applyConversationUpdate(fixture.models.projectConversation(id, "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: snapshot(id),
    });
  }
  fixture.root.appShellStore.selectProjectSession("alpha");
  fixture.root.projectWorkbenchStore.showLoadedSession("alpha");
  fixture.root.sessionLayoutStore.ensureSession("alpha");
  const view = render(
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <App />
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    open,
    setFullscreenSurfaceOpen,
    persistedLayout() {
      return toSnapshot(fixture.root.sessionLayoutStore);
    },
    hostClose(surfaceId: string) {
      // Delivery point of observeSurfaceEvents; this exercises product close routing,
      // not Electron transport delivery or native Escape/hit testing.
      act(() => fixture.root.fullscreenSurfaceStore.requestClose(surfaceId));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  // Observe registration without inventing layout measurements; geometry is not under test.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

function pane(title: string) {
  const heading = screen.getAllByText(title).find((element) => element.tagName === "STRONG");
  const section = heading?.closest("section");
  if (!section) throw new Error(`Missing visible pane for ${title}`);
  return within(section);
}

describe("Session layout workflow", () => {
  it("back enables Forward, forward returns to the selected session, and a divergent visit truncates it", async () => {
    using fixture = renderLayout();
    const back = screen.getByRole("button", { name: "Go back in session history" });
    const forward = screen.getByRole("button", { name: "Go forward in session history" });
    await fixture.user.click(screen.getByRole("button", { name: /^beta conversation / }));
    expect(back.hasAttribute("disabled")).toBe(false);
    expect(forward.hasAttribute("disabled")).toBe(true);
    await fixture.user.click(back);
    expect(pane("alpha conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(forward.hasAttribute("disabled")).toBe(false);
    await fixture.user.click(forward);
    expect(pane("beta conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(back);
    await fixture.user.click(screen.getByRole("button", { name: /^gamma conversation / }));
    expect(forward.hasAttribute("disabled")).toBe(true);
    await fixture.user.click(back);
    expect(pane("alpha conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(forward);
    expect(pane("gamma conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it("traverses to the pane's actual target rather than the intervening window visit", async () => {
    using fixture = renderLayout();
    await fixture.user.click(screen.getByRole("button", { name: "Split down" }));
    await fixture.user.click(screen.getByRole("button", { name: /^beta conversation / }));
    await fixture.user.click(pane("alpha conversation").getByRole("combobox", { name: "Message" }));
    await fixture.user.click(screen.getByRole("button", { name: /^gamma conversation / }));
    const back = screen.getByRole("button", { name: "Go back in session history" });
    const forward = screen.getByRole("button", { name: "Go forward in session history" });
    await fixture.user.click(back);
    expect(pane("alpha conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(pane("beta conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(forward.hasAttribute("disabled")).toBe(false);
    await fixture.user.click(forward);
    expect(pane("gamma conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(pane("beta conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it("splits into a new composer, navigates in that pane and closes back to a single conversation", async () => {
    using fixture = renderLayout();
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Split right" }));
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(2);
    expect(pane("alpha conversation").getByText("1")).toBeDefined();
    expect(pane("New chat").getByText("2")).toBeDefined();
    expect(screen.getByRole("separator", { name: "Resize session columns" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta conversation / }));
    expect(pane("alpha conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(pane("beta conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(pane("beta conversation").getByRole("button", { name: "Close pane" }));
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(1);
    expect(pane("alpha conversation").queryByText("1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize session columns" })).toBeNull();
  });

  it("navigates within the selected pane and reuses an already-visible conversation", async () => {
    using fixture = renderLayout();
    await fixture.user.click(screen.getByRole("button", { name: "Split down" }));
    await fixture.user.click(screen.getByRole("button", { name: /^beta conversation / }));
    expect(screen.getByRole("separator", { name: "Resize session rows" })).toBeDefined();
    await fixture.user.click(pane("alpha conversation").getByRole("combobox", { name: "Message" }));
    await fixture.user.click(screen.getByRole("button", { name: /^gamma conversation / }));
    expect(pane("gamma conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(pane("beta conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Go back in session history" }));
    expect(pane("alpha conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta conversation / }));
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(2);
    await fixture.user.click(screen.getByRole("button", { name: /^gamma conversation / }));
    expect(pane("alpha conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(pane("gamma conversation").getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it("restores saved split geometry into the real panes and persists a fresh split after closing one", async () => {
    using fixture = renderLayout(0.65);
    const split = () => document.querySelector<HTMLElement>('[data-slot="session-split"]')!;
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(2);
    expect(split().style.getPropertyValue("--split-first")).toBe("0.65fr");
    expect(pane("alpha conversation").getByText("1")).toBeDefined();
    expect(pane("beta conversation").getByText("2")).toBeDefined();
    await fixture.user.click(pane("beta conversation").getByRole("button", { name: "Close pane" }));
    await fixture.user.click(screen.getByRole("button", { name: "Split right" }));
    expect(split().style.getPropertyValue("--split-first")).toBe("0.5fr");
    expect(fixture.persistedLayout()).toMatchObject({
      state: { layout: { kind: "split", axis: "x", ratio: 0.5 } },
    });
  });

  it("restores the staged draft without dropping the focused pane's persisted forward history", async () => {
    using fixture = renderLayout();
    const newChat = () => screen.getByRole("button", { name: "Start new chat in project" });
    const input = () => screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    await fixture.user.click(newChat());
    await fixture.user.type(input(), "Retained staged work");
    await fixture.user.click(screen.getByRole("button", { name: /^beta conversation / }));
    expect(input().value).toBe("");
    await fixture.user.click(newChat());
    expect(input().value).toBe("Retained staged work");
    expect(screen.getByText("New chat")).toBeDefined();
    // Shell Forward records restoration as a new visit and cannot expose this
    // pane-local branch. Assert the actual persistence representation instead;
    // this does not claim native window-state transport/restoration coverage.
    expect(fixture.persistedLayout()).toMatchObject({
      state: {
        layout: {
          kind: "pane",
          history: ["alpha", expect.any(String), "beta"],
          historyCursor: 1,
        },
      },
    });
  });

  it("limits splitting to four panes and permits another split after closing one", async () => {
    using fixture = renderLayout();
    for (let index = 0; index < 3; index++)
      await fixture.user.click(screen.getAllByRole("button", { name: "Split right" }).at(-1)!);
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(4);
    for (const button of screen.getAllByRole("button", { name: /Split (right|down)/ }))
      expect(button.hasAttribute("disabled")).toBe(true);
    await fixture.user.click(screen.getAllByRole("button", { name: "Split right" })[0]!);
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(4);
    await fixture.user.click(screen.getAllByRole("button", { name: "Close pane" }).at(-1)!);
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(3);
    expect(
      screen.getAllByRole("button", { name: "Split right" })[0]!.hasAttribute("disabled"),
    ).toBe(false);
  });

  it("coordinates native fullscreen state when the continuation dialog opens and closes", async () => {
    using fixture = renderLayout();
    const openDialog = async () => {
      await fixture.user.click(screen.getByRole("button", { name: "Session tree" }));
      await fixture.user.click(screen.getByRole("button", { name: "Fork from Finished work" }));
      return screen.findByRole("dialog", { name: "Fork this conversation" });
    };
    await openDialog();
    expect(fixture.setFullscreenSurfaceOpen).toHaveBeenCalledWith(expect.any(String), true);
    const surfaceId = fixture.setFullscreenSurfaceOpen.mock.calls[0]![0];
    await fixture.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fixture.setFullscreenSurfaceOpen).toHaveBeenCalledWith(surfaceId, false);
    const dialog = await openDialog();
    await fixture.user.click(
      within(dialog).getByRole("button", { name: "Exit fullscreen Fork this conversation" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.setFullscreenSurfaceOpen.mock.calls.map(([, open]) => open)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it("closes only the fullscreen surface named by the host request and unregisters it before reopening", async () => {
    using fixture = renderLayout();
    const openDialog = async () => {
      await fixture.user.click(screen.getByRole("button", { name: "Session tree" }));
      await fixture.user.click(screen.getByRole("button", { name: "Fork from Finished work" }));
      return screen.findByRole("dialog", { name: "Fork this conversation" });
    };
    await openDialog();
    const firstId = fixture.setFullscreenSurfaceOpen.mock.calls[0]![0];
    fixture.hostClose("unrelated-surface");
    expect(screen.getByRole("dialog", { name: "Fork this conversation" })).toBeDefined();
    fixture.hostClose(firstId);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fixture.setFullscreenSurfaceOpen).toHaveBeenCalledWith(firstId, false);
    await openDialog();
    const secondId = fixture.setFullscreenSurfaceOpen.mock.calls.at(-1)![0];
    expect(secondId).not.toBe(firstId);
    fixture.hostClose(firstId);
    expect(screen.getByRole("dialog", { name: "Fork this conversation" })).toBeDefined();
    fixture.hostClose(secondId);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fixture.setFullscreenSurfaceOpen.mock.calls.map(([, open]) => open)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});
