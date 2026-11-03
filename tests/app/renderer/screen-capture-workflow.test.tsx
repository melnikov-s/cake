/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount, applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  CapturePreferences,
  type CaptureCompletion,
} from "../../../src/contracts/desktop/screen-capture-data";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { ScreenCaptureOverlay } from "../../../src/renderer/components/screen-capture-overlay";
import { ScreenCaptureOverlayStore } from "../../../src/renderer/stores/ScreenCaptureOverlayStore";
import { createTestClient } from "./test-client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { applyAutomationCatalogUpdate } from "../../../src/renderer/reducers/AutomationReducer";
import { automationSession, automationSummary } from "./fixtures/automation-fixtures";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function emptyConversation(sessionId: string): ConversationSnapshot {
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
    tree: [],
  };
}
function renderCapture(startOverride?: Client["electron"]["startScreenCapture"], staged = false) {
  let overlay: { unmount(): void } | undefined;
  let overlayStore: ScreenCaptureOverlayStore | undefined;
  const startScreenCapture = vi.fn<Client["electron"]["startScreenCapture"]>(
    startOverride ??
      (async (routing) => {
        const client = createTestClient({});
        const completion = new Promise<CaptureCompletion>((resolve) => {
          overlayStore = mount(
            createStore(ScreenCaptureOverlayStore, {
              client: {
                screenCaptureState: async () => ({
                  routing,
                  image: "data:image/png;base64,fixture",
                  width: 1200,
                  height: 800,
                  maxDimension: 1024,
                }),
                finishScreenCapture: async (capture, annotationColor) => {
                  resolve({
                    annotationColor,
                    ...(capture
                      ? {
                          capture: {
                            data: png,
                            annotationText: capture.annotationText,
                            destination: capture.destination,
                          },
                        }
                      : {}),
                  });
                },
              },
              speech: {
                client: client.dictation,
                postProcess: client.workspaces.postProcessDictation,
                microphone: {
                  open: async () => {
                    throw new Error("No microphone");
                  },
                  devices: async () => [],
                },
              },
              renderImage: async () => "data:image/png;base64,fixture",
              copy: async () => {},
            }),
          );
        });
        overlay = render(<ScreenCaptureOverlay store={overlayStore!} />);
        await overlayStore!.initialize();
        try {
          return await completion;
        } finally {
          overlay.unmount();
          overlay = undefined;
          overlayStore![Symbol.dispose]();
          overlayStore = undefined;
        }
      }),
  );
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => TurnId.make("capture-turn"));
  const configureScreenCapture = vi.fn<Client["electron"]["configureScreenCapture"]>(
    async () => {},
  );
  const openSession = vi.fn<Client["projectSessions"]["open"]>(
    async ({ sessionId, workingDirectory }) => {
      applyConversationUpdate(fixture.models.projectConversation(sessionId, workingDirectory!), {
        _tag: "Snapshot",
        revision: 1,
        snapshot: emptyConversation(sessionId),
      });
    },
  );
  const menu = vi.fn<Client["electron"]["showSessionContextMenu"]>(async () => undefined);
  const projectMenu = vi.fn<Client["electron"]["showProjectContextMenu"]>(async () => undefined);
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/project", name: "Project" }),
      projectRecord({ path: "/other", name: "Other Project" }),
    ],
    sessions: [
      ...(!staged
        ? [sessionSummary({ sessionId: "alpha", title: "Session A", projectPath: "/project" })]
        : []),
      sessionSummary({ sessionId: "beta", title: "Session B", projectPath: "/project" }),
      sessionSummary({
        sessionId: "gamma",
        title: "Session C",
        projectPath: "/other",
        workingDirectory: "/other",
      }),
    ],
    client: {
      electron: {
        startScreenCapture,
        configureScreenCapture,
        showSessionContextMenu: menu,
        showProjectContextMenu: projectMenu,
      },
      cakeChats: {
        open: async ({ sessionId }) => {
          applyConversationUpdate(fixture.models.cakeChatConversation(sessionId), {
            _tag: "Snapshot",
            revision: 1,
            snapshot: emptyConversation(sessionId),
          });
        },
      },
      sessionChats: { prompt },
      projectSessions: { open: openSession },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: projectChatId,
        title: "Project Chat",
        projectPath: "/project",
        createdAt: "2026-01-01T00:00:00Z",
        modifiedAt: "2026-01-01T00:00:00Z",
        messageCount: 0,
        resolved: false,
        unread: false,
      },
    ],
  });
  fixture.root.cakeChatCollectionStore.registry.load(projectChatId);
  applyConversationUpdate(fixture.models.cakeChatConversation(projectChatId), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: emptyConversation(projectChatId),
  });
  const capture = fixture.root.screenCaptureStore;
  for (const id of ["alpha", "beta"]) {
    if (staged && id === "alpha") {
      fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", id);
      continue;
    }
    fixture.root.sessionRegistry.load(id, "/project");
    applyConversationUpdate(fixture.models.projectConversation(id, "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: emptyConversation(id),
    });
  }
  const select = (id: string) => {
    fixture.root.navigationStore.selectProjectSession(id);
    fixture.root.projectWorkbenchStore.showLoadedSession(id);
    fixture.root.sessionLayoutStore.ensureSession(id);
  };
  select("alpha");
  fixture.root.sessionRegistry
    .findSession("alpha")!
    .conversationSessionStore.composerStore.draftStore.setText("Existing draft");
  fixture.root.appShellStore.recordConversationInteraction({
    kind: "project-session",
    sessionId: "alpha",
  });
  fixture.root.appShellStore.showSettings();
  fixture.root.settingsStore.selectPage("screen-capture");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    root: fixture.root,
    models: fixture.models,
    capture,
    startScreenCapture,
    configureScreenCapture,
    prompt,
    menu,
    projectMenu,
    openSession,
    select,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      overlay?.unmount();
      overlayStore?.[Symbol.dispose]();
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function expectExistingDraft() {
  const input = screen.getByRole("combobox", { name: "Message" });
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected chat composer");
  expect(input.value).toBe("Existing draft");
}
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: query.includes("prefers-reduced-motion"),
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

const projectChatId = `project-chat:${"a".repeat(64)}`;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

const normalSidebar = () =>
  document.querySelector<HTMLElement>('[data-slot="sidebar"][data-view="navigation"]')!;
const popup = () => screen.getByRole("dialog", { name: "Screenshot destination" });
const rowIds = (scope: HTMLElement) =>
  [...scope.querySelectorAll(".session-item")]
    .map((row) => row.getAttribute("data-session-id"))
    .filter((id) => id === "alpha" || id === "beta");
async function begin(fixture: ReturnType<typeof renderCapture>) {
  await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
  await screen.findByRole("toolbar", { name: "Screen capture tools" });
}
async function openMenu(fixture: ReturnType<typeof renderCapture>) {
  await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
  return within(popup());
}
describe("Screen capture attachment destinations", () => {
  it("keeps the last editable interaction when an automation is opened", async () => {
    using fixture = renderCapture();
    const base = automationSession();
    const run = automationSession({
      identity: {
        ...base.identity,
        context: { _tag: "Project", projectPath: "/project" },
        workingDirectory: "/project",
      },
    });
    await act(async () => {
      applyAutomationCatalogUpdate(fixture.models.automations, {
        _tag: "Snapshot",
        snapshot: {
          revision: 1,
          automations: [
            automationSummary({
              context: { _tag: "Project", projectPath: "/project" },
              activity: { runningSessions: 1, queuedOccurrences: 0 },
            }),
          ],
          unresolvedSessions: [run],
        },
      });
      await fixture.root.navigationStore.openAutomationSession(run.identity.sessionId);
      fixture.root.appShellStore.showSettings();
    });
    await begin(fixture);
    expect(fixture.startScreenCapture.mock.calls[0]![0].defaultDestination).toEqual({
      kind: "project-session",
      sessionId: "alpha",
    });
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("selects Project Chat on the first screen without navigating until completion", async () => {
    using fixture = renderCapture();
    await begin(fixture);
    const menu = await openMenu(fixture);
    await fixture.user.click(menu.getByRole("button", { name: "Collapse Project" }));
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("alpha");
    await fixture.user.click(menu.getByRole("button", { name: "Open Project Chat for Project" }));
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    await screen.findByRole("button", { name: /^View Screenshot-/ });
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "cake-chat",
      sessionId: projectChatId,
    });
    expect(fixture.openSession).not.toHaveBeenCalled();
  });

  it("chooses the destination on the first native screen, then attaches pixels and annotation text without another step", async () => {
    using fixture = renderCapture();
    await begin(fixture);
    Schema.decodeUnknownSync(CapturePreferences)(fixture.startScreenCapture.mock.calls[0]![0]);
    const menu = await openMenu(fixture);
    await fixture.user.click(menu.getByRole("button", { name: /^Session B / }));
    expect(screen.getByRole("button", { name: "Screenshot destination" }).textContent).toContain(
      "Session B",
    );
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("alpha");
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("beta");
    expect(fixture.prompt).not.toHaveBeenCalled();
    act(() => fixture.select("alpha"));
    expectExistingDraft();
  });

  it("defaults to the most recently user-interacted conversation, not a programmatic open or screenshot choice", async () => {
    using fixture = renderCapture();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await fixture.user.click(within(normalSidebar()).getByRole("button", { name: /^Session B / }));
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("beta"),
    );
    act(() => {
      fixture.select("alpha"); // same navigation used by programmatic opens
      fixture.root.appShellStore.showSettings();
    });
    await begin(fixture);
    expect(screen.getByRole("button", { name: "Screenshot destination" }).textContent).toContain(
      "Session B",
    );
    const menu = await openMenu(fixture);
    await fixture.user.click(menu.getByRole("button", { name: /^Session C / }));
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    await screen.findByRole("button", { name: /^View Screenshot-/ });
    await fixture.user.click(
      within(normalSidebar()).getByRole("button", { name: "Open settings" }),
    );
    await begin(fixture);
    expect(screen.getByRole("button", { name: "Screenshot destination" }).textContent).toContain(
      "Session B",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("updates interaction from the conversation pane, including an already-focused pane", async () => {
    using fixture = renderCapture();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    act(() => fixture.select("beta"));
    await fixture.user.click(screen.getByRole("combobox", { name: "Message" }));
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Hello");
    await fixture.user.click(
      within(normalSidebar()).getByRole("button", { name: "Open settings" }),
    );
    await begin(fixture);
    expect(screen.getByRole("button", { name: "Screenshot destination" }).textContent).toContain(
      "Session B",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("isolates project and family disclosures in both directions and retains menu state on reopening", async () => {
    using fixture = renderCapture();
    act(() =>
      applySnapshot(fixture.models.sessionCatalog, {
        sessions: [
          sessionSummary({
            sessionId: "beta",
            title: "Parent",
            projectPath: "/project",
            familyChildSessionIds: ["alpha"],
            familyDepth: 0,
          }),
          sessionSummary({
            sessionId: "alpha",
            title: "Child",
            projectPath: "/project",
            familyParentSessionId: "beta",
            familyDepth: 1,
          }),
        ],
      }),
    );
    await begin(fixture);
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await fixture.user.click(
      within(normalSidebar()).getByRole("button", { name: "Collapse children of Parent" }),
    );
    await fixture.user.click(
      within(normalSidebar()).getByRole("button", { name: "Collapse Project" }),
    );
    let menu = await openMenu(fixture);
    expect(rowIds(popup())).toEqual(["beta", "alpha"]); // never seeded from sidebar disclosures
    await fixture.user.click(menu.getByRole("button", { name: "Collapse children of Parent" }));
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    await fixture.user.click(
      within(normalSidebar()).getByRole("button", { name: "Expand Project" }),
    );
    await fixture.user.click(
      within(normalSidebar()).getByRole("button", { name: "Expand children of Parent" }),
    );
    menu = await openMenu(fixture);
    expect(rowIds(popup())).toEqual(["beta"]);
    expect(rowIds(normalSidebar())).toEqual(["beta", "alpha"]);
    await fixture.user.click(menu.getByRole("button", { name: "Expand children of Parent" }));
    await fixture.user.click(menu.getByRole("button", { name: "Collapse children of Parent" }));
    expect(rowIds(normalSidebar())).toEqual(["beta", "alpha"]);
    await fixture.user.click(menu.getByRole("button", { name: "Collapse Project" }));
    expect(rowIds(normalSidebar())).toEqual(["beta", "alpha"]);
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    menu = await openMenu(fixture);
    expect(menu.getByRole("button", { name: "Expand Project" })).toBeDefined();
    expect(rowIds(popup())).toEqual([]);
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("attaches directly to the unsent interacted pane and preserves its existing draft", async () => {
    using fixture = renderCapture(undefined, true);
    await begin(fixture);
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    await screen.findByRole("button", { name: /^View Screenshot-/ });
    expectExistingDraft();
    expect(fixture.openSession).not.toHaveBeenCalled();
  });

  it.each(["resolved", "missing"] as const)(
    "revalidates a %s destination before attaching",
    async (state) => {
      using fixture = renderCapture();
      await begin(fixture);
      act(() => {
        const session = fixture.models.sessionCatalog.sessions.find(
          (s) => s.sessionId === "alpha",
        )!;
        if (state === "resolved") session.resolved = true;
        else
          fixture.models.sessionCatalog.sessions.splice(
            fixture.models.sessionCatalog.sessions.indexOf(session),
            1,
          );
      });
      await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
      expect(await screen.findByText("The destination chat is no longer editable.")).toBeDefined();
      expect(fixture.prompt).not.toHaveBeenCalled();
    },
  );

  it("uses an available destination when the last interaction is stale", async () => {
    using fixture = renderCapture();
    act(() => {
      fixture.models.sessionCatalog.sessions.find((s) => s.sessionId === "alpha")!.resolved = true;
    });
    await begin(fixture);
    expect(fixture.startScreenCapture.mock.calls[0]![0].defaultDestination).toEqual({
      kind: "project-session",
      sessionId: "beta",
    });
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("preserves numbered annotations and the existing Send flow", async () => {
    using fixture = renderCapture(async (routing) => ({
      annotationColor: "pink",
      capture: {
        data: png,
        annotationText: "1. Arrow note\n   continued\n2. Freehand note",
        destination: routing.defaultDestination!,
      },
    }));
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await screen.findByRole("button", { name: /^View Screenshot-/ });
    const input = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    expect(input.value).toMatch(/Existing draft\n\nScreenshot-[^\n]+\n1\. Arrow note/);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.prompt).toHaveBeenCalledOnce());
    expect(fixture.prompt.mock.calls[0]![0].attachments).toEqual([
      expect.objectContaining({ kind: "image", data: png }),
    ]);
  });

  it("leaves the draft unchanged on cancellation and reports native failure with retry", async () => {
    const start = vi
      .fn<Client["electron"]["startScreenCapture"]>()
      .mockRejectedValueOnce(new Error("Allow screen recording"))
      .mockResolvedValueOnce({ annotationColor: "yellow" });
    using fixture = renderCapture(start);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(await screen.findByText("Allow screen recording")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expectExistingDraft();
  });

  it("configures image size and shortcut from Settings", async () => {
    using fixture = renderCapture();
    await fixture.user.selectOptions(screen.getByLabelText("Maximum image dimension"), "1024");
    await waitFor(() =>
      expect(fixture.configureScreenCapture).toHaveBeenLastCalledWith(
        { shortcut: "Mod+Shift+6", maxDimension: 1024 },
        expect.anything(),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(fixture.configureScreenCapture).toHaveBeenLastCalledWith(
        { shortcut: "", maxDimension: 1024 },
        expect.anything(),
      ),
    );
  });
});
