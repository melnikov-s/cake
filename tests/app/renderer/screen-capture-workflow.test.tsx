/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
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
function renderCapture(
  startScreenCapture: Client["electron"]["startScreenCapture"],
  staged = false,
) {
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
    configureScreenCapture,
    prompt,
    menu,
    projectMenu,
    openSession,
    select,
    user: userEvent.setup(),
    [Symbol.dispose]() {
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
const captured: CaptureCompletion = {
  annotationColor: "yellow",
  capture: { data: png, annotationText: "" },
};
const popup = () => screen.getByRole("dialog", { name: "Screenshot destination" });
const normalSidebar = () =>
  document.querySelector<HTMLElement>('[data-slot="sidebar"][data-view="navigation"]')!;
const rowIds = (scope: HTMLElement) =>
  [...scope.querySelectorAll(".session-item")].map((row) => row.getAttribute("data-session-id"));
async function begin(fixture: ReturnType<typeof renderCapture>, showMain = false) {
  await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
  await screen.findByRole("dialog", { name: "Screenshot destination" });
  if (showMain) {
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
  }
  return within(popup());
}

describe("Screen capture attachment destinations", () => {
  it("keeps automation navigation in the main sidebar while capture destinations use the remembered editable chat", async () => {
    using fixture = renderCapture(async () => captured);
    const base = automationSession();
    const run = automationSession({
      title: "Automated capture work",
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
      fixture.root.settingsStore.selectPage("screen-capture");
    });
    expect(fixture.capture.currentDestination).toEqual({
      kind: "project-session",
      sessionId: "alpha",
    });
    const menu = await begin(fixture, true);
    expect(normalSidebar().querySelector('[data-slot="sidebar-automations"]')).not.toBeNull();
    expect(within(normalSidebar()).getByText("Automated capture work")).toBeDefined();
    expect(popup().querySelector('[data-slot="sidebar-automations"]')).toBeNull();
    expect(menu.queryByText("Automated capture work")).toBeNull();
    await fixture.user.click(menu.getByRole("button", { name: "Attach to current chat" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
    expect(fixture.root.appShellStore.selection).toEqual({
      kind: "project-session",
      sessionId: "alpha",
    });
    expect(fixture.prompt).not.toHaveBeenCalled();
  });
  it("adds numbered text and pixels once to the current unsent chat, then uses the existing Send flow", async () => {
    const start = vi.fn<Client["electron"]["startScreenCapture"]>(async () => ({
      ...captured,
      capture: { data: png, annotationText: "1. Arrow note\n   continued\n2. Freehand note" },
    }));
    using fixture = renderCapture(start);
    const menu = await begin(fixture);
    Schema.decodeUnknownSync(CapturePreferences)(start.mock.calls[0]![0]);
    await fixture.user.click(menu.getByRole("button", { name: "Attach to current chat" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    const input = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    expect(input.value).toMatch(/Existing draft\n\nScreenshot-[^\n]+\n1\. Arrow note/);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.prompt).toHaveBeenCalledOnce());
    const sent = fixture.prompt.mock.calls[0]![0];
    expect(sent.text.match(/1\. Arrow note/g)).toHaveLength(1);
    expect(sent.attachments).toEqual([expect.objectContaining({ kind: "image", data: png })]);
  });

  it("attaches to an unsent current pane without inventing sidebar rows", async () => {
    using fixture = renderCapture(async () => captured, true);
    const menu = await begin(fixture);
    expect(rowIds(popup())).not.toContain("alpha");
    await fixture.user.click(menu.getByRole("button", { name: "Attach to current chat" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
    expect(fixture.openSession).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it("shares project and family collapse live in both directions, including reopening", async () => {
    using fixture = renderCapture(async () => captured);
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
    await begin(fixture, true);
    const main = within(normalSidebar());
    await fixture.user.click(main.getByRole("button", { name: "Collapse Project" }));
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    let menu = within(popup());
    expect(menu.getByRole("button", { name: "Expand Project" })).toBeDefined();
    expect(rowIds(popup())).toEqual([]);
    await fixture.user.click(menu.getByRole("button", { name: "Expand Project" }));
    expect(main.getByRole("button", { name: "Collapse Project" })).toBeDefined();
    expect(rowIds(normalSidebar())).toEqual(rowIds(popup()));
    await fixture.user.click(menu.getByRole("button", { name: "Collapse children of Parent" }));
    expect(rowIds(normalSidebar())).toEqual(["beta"]);
    expect(rowIds(popup())).toEqual(["beta"]);
    // Escape dismisses just the menu; the screenshot can be reopened without a new capture.
    await fixture.user.keyboard("{Escape}");
    await fixture.user.click(main.getByRole("button", { name: "Expand children of Parent" }));
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    menu = within(popup());
    expect(rowIds(popup())).toEqual(["beta", "alpha"]);
    await fixture.user.click(menu.getByRole("button", { name: "Collapse Project" }));
    await fixture.user.keyboard("{Escape}");
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    expect(within(popup()).getByRole("button", { name: "Expand Project" })).toBeDefined();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.openSession).not.toHaveBeenCalled();
  });

  it("keeps real project/session ordering and presentation, even when normal navigation shows activity", async () => {
    using fixture = renderCapture(async () => captured);
    act(() => {
      fixture.root.projectCatalogStore.move("/other", "/project", "before");
      fixture.root.sidebarStore.sessionListStore.setProjectSessionSort("/project", "label");
    });
    await begin(fixture, true);
    const expected = rowIds(normalSidebar());
    expect(rowIds(popup())).toEqual(expected);
    const projectNames = (scope: HTMLElement) =>
      [...scope.querySelectorAll('[data-slot="project-label"]')].map((row) => row.textContent);
    expect(projectNames(popup())).toEqual(projectNames(normalSidebar()));
    expect(projectNames(popup())).toEqual(["Other Project", "Project"]);
    expect(popup().querySelector('[data-slot="avatar"]')).not.toBeNull();
    await fixture.user.keyboard("{Escape}");
    await fixture.user.click(
      within(normalSidebar()).getByRole("button", { name: "Show activity" }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    expect(rowIds(popup())).toEqual(expected);
  });

  it("project disclosure never attaches; the project label attaches to Project Chat, not a new session", async () => {
    using fixture = renderCapture(async () => captured);
    const menu = await begin(fixture);
    await fixture.user.click(menu.getByRole("button", { name: "Collapse Project" }));
    expect(screen.queryByRole("button", { name: /^View Screenshot-/ })).toBeNull();
    expect(fixture.openSession).not.toHaveBeenCalled();
    await fixture.user.click(menu.getByRole("button", { name: "Open Project Chat for project" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "cake-chat",
      sessionId: projectChatId,
    });
    expect(fixture.openSession).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
    act(() => fixture.select("alpha"));
    expectExistingDraft();
    expect(screen.queryByRole("button", { name: /^View Screenshot-/ })).toBeNull();
  });

  it.each(["Session B", "Session C"])(
    "routes the chosen %s row through the existing attachment flow",
    async (title) => {
      using fixture = renderCapture(async () => captured);
      const menu = await begin(fixture);
      await fixture.user.click(menu.getByRole("button", { name: new RegExp(`^${title} `) }));
      expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
      expect(fixture.root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: title === "Session B" ? "beta" : "gamma",
      });
      if (title === "Session C")
        expect(fixture.openSession).toHaveBeenCalledWith(
          { sessionId: "gamma", workingDirectory: "/other" },
          expect.anything(),
        );
      expect(fixture.prompt).not.toHaveBeenCalled();
      act(() => fixture.select("alpha"));
      expectExistingDraft();
    },
  );

  it("suppresses management only in the selection surface", async () => {
    using fixture = renderCapture(async () => captured);
    const menu = await begin(fixture, true);
    expect(menu.queryByRole("button", { name: "Project actions for project" })).toBeNull();
    expect(menu.queryByRole("button", { name: "Resolve Session A" })).toBeNull();
    expect(menu.queryByRole("button", { name: /New chat|Add project|Open settings/ })).toBeNull();
    expect(popup().querySelector('[draggable="true"]')).toBeNull();
    await fixture.user.pointer({
      target: menu.getByRole("button", { name: /^Session A / }),
      keys: "[MouseRight]",
    });
    await fixture.user.pointer({
      target: menu.getByRole("button", { name: "Open Project Chat for project" }),
      keys: "[MouseRight]",
    });
    expect(fixture.menu).not.toHaveBeenCalled();
    expect(fixture.projectMenu).not.toHaveBeenCalled();
    await fixture.user.keyboard("{Escape}");
    const main = within(normalSidebar());
    expect(main.getByRole("button", { name: "Project actions for project" })).toBeDefined();
    expect(main.getByRole("button", { name: "Resolve Session A" })).toBeDefined();
    await fixture.user.pointer({
      target: main.getByRole("button", { name: /^Session A / }),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(fixture.menu).toHaveBeenCalledOnce());
  });

  it("can discard a screenshot without changing the draft", async () => {
    using fixture = renderCapture(async () => captured);
    const menu = await begin(fixture);
    await fixture.user.click(menu.getByRole("button", { name: "Cancel screenshot attachment" }));
    expect(screen.queryByRole("button", { name: "Screenshot destination" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expectExistingDraft();
    expect(screen.queryByRole("button", { name: /^View Screenshot-/ })).toBeNull();
  });

  it("leaves the draft unchanged on native cancellation and reports failures with retry", async () => {
    const start = vi
      .fn<Client["electron"]["startScreenCapture"]>()
      .mockRejectedValueOnce(new Error("Allow screen recording"))
      .mockResolvedValueOnce({ annotationColor: "yellow" })
      .mockResolvedValueOnce(captured);
    using fixture = renderCapture(start);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(await screen.findByText("Allow screen recording")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(screen.queryByRole("button", { name: "Screenshot destination" })).toBeNull();
    const menu = await begin(fixture);
    await fixture.user.click(menu.getByRole("button", { name: "Attach to current chat" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
  });

  it("does not attach to a current chat resolved during capture", async () => {
    let complete!: (value: CaptureCompletion) => void;
    const result = new Promise<CaptureCompletion>((resolve) => {
      complete = resolve;
    });
    using fixture = renderCapture(async () => result);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    act(() => {
      fixture.models.sessionCatalog.sessions.find((s) => s.sessionId === "alpha")!.resolved = true;
    });
    await act(async () => complete(captured));
    await fixture.user.click(
      within(popup()).getByRole("button", { name: "Attach to current chat" }),
    );
    expect(await screen.findByText("The destination chat is no longer editable.")).toBeDefined();
  });

  it("configures image size and shortcut from Settings", async () => {
    using fixture = renderCapture(async () => ({ annotationColor: "yellow" }));
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
