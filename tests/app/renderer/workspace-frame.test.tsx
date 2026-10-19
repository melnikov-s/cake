/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
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
  vi.stubGlobal("innerWidth", 1600);
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
      artifacts: {
        detail: async () => {
          throw new Error("Artifact temporarily unavailable");
        },
        history: async () => ({ items: [], offset: 0, limit: 25, total: 0, hasMore: false }),
      },
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
  root.terminalStore.dock();
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

// Real workflow Stores, Models, controls, Chat, side-chat and artifact composition.
// These assertions cover rendered wiring, not pixel layout, native input or focus.
describe.each<Kind>(["project", "cake-chat"])("%s workspace frame", (kind) => {
  it.each<Mode>(["browser", "vscode"])(
    "%s retains sidebar selection/alignment, dock sizes, side chats/artifacts and workflow slots",
    async (mode) => {
      using f = renderWorkspace(kind, mode);
      const { container } = f.view;
      const main = screen.getByRole("main");
      const workspace = screen.getByRole("region", {
        name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
      });
      expect(workspace).toBeDefined();
      expect(main.style.getPropertyValue("--workspace-project-sidebar-width")).toBe("292px");
      expect(main.style.getPropertyValue("--workspace-chat-sidebar-width")).toBe("440px");
      if (kind === "project") {
        expect(
          container
            .querySelector(`[data-session-id="${f.session.sessionId}"]`)
            ?.getAttribute("data-navigation-active"),
        ).toBe("true");
      } else {
        expect(
          screen
            .getByRole("button", { name: "Open Project Chat for project" })
            .getAttribute("aria-current"),
        ).toBe("page");
      }
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
      expect(screen.queryByRole("button", { name: "Ask session assistant" }) !== null).toBe(
        kind === "project",
      );
      expect(
        screen.queryByRole("button", { name: "Fork response with full context into new chat" }) !==
          null,
      ).toBe(kind === "project");
      expect(
        screen.queryByRole("button", { name: "Continue from response in session tree" }) !== null,
      ).toBe(kind === "project");

      act(() => f.root.sidebarStore.focusProject("/project"));
      expect(main.style.getPropertyValue("--workspace-project-sidebar-width")).toBe("360px");
      act(() => f.root.sidebarStore.setWidth(390));
      expect(main.style.getPropertyValue("--workspace-project-sidebar-width")).toBe("390px");
      const terminal = screen.getByLabelText("Terminal", { selector: "section" });
      expect(terminal.style.height).toBe("360px");
      // The dock spans workspace + chat, never the project navigation column.
      expect(terminal.parentElement).toBe(workspace.parentElement?.parentElement);
      fireEvent.keyDown(
        within(terminal).getByRole("separator", { name: "Resize terminal", hidden: true }),
        { key: "ArrowUp" },
      );
      expect(terminal.style.height).toBe("376px");
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
      await f.user.click(screen.getByRole("button", { name: "Close Side chat" }));
      expect(
        screen.getByRole("combobox", {
          name: kind === "project" ? "Message" : "Message Project Chat",
        }),
      ).toBeDefined();

      act(() =>
        f.root.artifactPaneStore.open(
          f.session.sessionId,
          decodeArtifactLineageId("workspace-artifact"),
        ),
      );
      const artifact = await screen.findByRole("complementary", { name: "Artifact" });
      expect(within(artifact).getByText("Session artifact")).toBeDefined();
      await f.user.click(within(artifact).getByRole("button", { name: "Close Artifact" }));
      expect(screen.queryByRole("complementary", { name: "Artifact" })).toBeNull();
      expect(
        screen.getByRole("region", {
          name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
        }),
      ).toBe(workspace);
    },
  );
});
