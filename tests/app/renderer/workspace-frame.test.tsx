/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CakeChatWorkspaceSurface } from "../../../src/renderer/components/cake-chat-workspace-surface";
import { ProjectWorkspaceSurface } from "../../../src/renderer/components/project-workspace-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectId = "workspace-project";
const cakeChatId = `project-chat:${"a".repeat(64)}`;
type Kind = "project" | "cake-chat";
type Mode = "browser" | "vscode";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 1200, 900),
  );
  // jsdom has no SVG/text layout; Electron verifies actual geometry and input.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  const rect = new DOMRect(0, 0, 100, 20);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [rect],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
});

function renderWorkspace(kind: Kind, mode: Mode) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({ sessionId: projectId, projectPath: "/project", title: "Project task" }),
    ],
    client: {
      browser: {
        updateBounds: async ({ sessionId }) => ({
          sessionId,
          url: "about:blank",
          title: "Browser",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          inspecting: false,
        }),
      },
      vscode: { updateBounds: async () => undefined },
    },
  });
  const { root, models } = fixture;
  applySnapshot(models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: cakeChatId, title: "Project coordinator", projectPath: "/project" }],
  });
  const session =
    kind === "project"
      ? root.sessionRegistry.load(projectId, "/project")
      : root.cakeChatCollectionStore.registry.load(cakeChatId);
  if (kind === "project") {
    root.navigationStore.selectProjectSession(session.sessionId);
    root.projectWorkbenchStore.showLoadedSession(session.sessionId);
    root.sessionLayoutStore.ensureSession(session.sessionId);
  } else {
    root.navigationStore.selectCakeChat(session.sessionId);
    root.cakeChatCollectionStore.sessionLayoutStore.ensureSession(session.sessionId);
  }
  session.showPresentation(mode);
  session.setWorkspaceChatSidebarWidth(440);
  applyConversationSnapshot(session.model, {
    sessionId: session.sessionId,
    sessionFile: `/sessions/${session.sessionId}`,
    parts: [
      {
        id: "answer",
        kind: "text",
        role: "assistant",
        entryId: "entry-answer",
        text: "Workspace answer",
        status: "complete",
      },
    ],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  });
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const surface =
    kind === "project" ? (
      <ProjectWorkspaceSurface
        session={root.sessionRegistry.findSession(projectId)!}
        mode={mode}
        browserMode={false}
      />
    ) : (
      <CakeChatWorkspaceSurface
        session={root.cakeChatCollectionStore.registry.find(cakeChatId)!}
        mode={mode}
        browserMode={false}
      />
    );
  const view = render(
    <StoreProvider store={root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        {surface}
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  return {
    root,
    session,
    view,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

// Real workflow Stores, Models, controls, Chat and side-chat composition.
// These assertions cover rendered wiring, not pixel layout, native input or focus.
describe.each<Kind>(["project", "cake-chat"])("%s workspace frame", (kind) => {
  it("sizes the companion against the available center, not the desktop width", () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(64, 0, 700, 900),
    );
    using f = renderWorkspace(kind, "browser");
    expect(screen.getByRole("main").style.getPropertyValue("--workspace-chat-sidebar-width")).toBe(
      "340px",
    );
    expect(f.session.workspaceChatSidebarWidth).toBe(440);
  });
  it.each<Mode>(["browser", "vscode"])(
    "%s companion retains the same conversation and draft when closed and reopened",
    async (mode) => {
      using f = renderWorkspace(kind, mode);
      const chat = f.session.conversationSessionStore.chatStore;
      const draft = f.session.conversationSessionStore.composerStore.draftStore;
      const sessionId = f.session.sessionId;
      act(() => draft.setText("Continue the same conversation"));
      await f.user.click(screen.getByRole("button", { name: "Close chat" }));
      expect(f.session.workspaceChatSidebarVisible).toBe(false);
      expect(f.session.sessionId).toBe(sessionId);
      expect(f.session.conversationSessionStore.chatStore).toBe(chat);
      expect(draft.text).toBe("Continue the same conversation");
      await f.user.click(screen.getByRole("button", { name: "Open chat" }));
      expect(f.session.workspaceChatSidebarVisible).toBe(true);
      expect(f.session.conversationSessionStore.chatStore).toBe(chat);
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }).textContent,
      ).toBe("Continue the same conversation");
    },
  );
  it.each<Mode>(["browser", "vscode"])(
    "%s retains the focused conversation, companion resizing, side chats and workflow slots",
    async (mode) => {
      using f = renderWorkspace(kind, mode);
      const main = screen.getByRole("main");
      const workspace = screen.getByRole("region", {
        name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
      });
      expect(workspace).toBeDefined();
      expect(main.style.getPropertyValue("--workspace-chat-sidebar-width")).toBe("440px");
      expect(
        screen.getByRole("complementary", { name: "Current conversation companion" }),
      ).toBeDefined();
      expect(screen.getByRole("group", { name: "Conversation workspace" })).toBeDefined();
      expect(
        screen.getByText(kind === "project" ? "Project task" : "Project coordinator", {
          selector: "strong",
        }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", {
          name: mode === "browser" ? "Open VS Code" : "Open Browser Mode",
        }),
      ).toBeDefined();
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();
      expect(await screen.findByText("Workspace answer")).toBeDefined();
      expect(screen.getByRole("button", { name: "Ask session assistant" })).toBeDefined();
      expect(
        screen.queryByRole("button", { name: "Fork response with full context into new chat" }) !==
          null,
      ).toBe(kind === "project");
      expect(
        screen.queryByRole("button", { name: "Continue from response in session tree" }) !== null,
      ).toBe(kind === "project");

      fireEvent.keyDown(screen.getByRole("separator", { name: "Resize current session sidebar" }), {
        key: "ArrowLeft",
      });
      expect(main.style.getPropertyValue("--workspace-chat-sidebar-width")).toBe("456px");

      // The selection operation prepares the same real side-chat Store used by the transcript.
      act(() => {
        f.session.messageCommentsStore.prepareDraft({
          messageId: "answer",
          entryId: "entry-answer",
          selectedText: "Workspace",
          startOffset: 0,
          endOffset: 9,
          contextBefore: "",
          contextAfter: " answer",
        });
        f.session.conversationSessionStore.sideChatStore.open({
          key: "selection-draft",
          title: "Side chat",
          eyebrow: () => "Selection",
          chatStore: f.session.messageCommentsStore.draftChatStore,
        });
      });
      expect(screen.getByRole("combobox", { name: "Message about selected text" })).toBeDefined();
      await f.user.click(
        within(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).getByRole(
          "button",
          { name: kind === "project" ? "Project task" : "Project Chat" },
        ),
      );
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();

      expect(
        screen.getByRole("region", {
          name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
        }),
      ).toBe(workspace);
    },
  );
});
