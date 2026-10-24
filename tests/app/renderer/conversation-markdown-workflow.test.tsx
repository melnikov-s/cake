/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { RendererRoot } from "../../../src/renderer/components/renderer-root";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";
import { artifactRevision, referenceMetadata } from "./artifact-reference-workflow-fixture";

const projectChatId = `project-chat:${"a".repeat(64)}`;
const snapshot = (sessionId: string, content: string | UiPart[]): ConversationSnapshot => ({
  sessionId,
  sessionFile: `/sessions/${sessionId}`,
  parts:
    typeof content === "string"
      ? [{ id: "response", kind: "text", role: "assistant", status: "complete", text: content }]
      : content,
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

function renderResources(
  texts: {
    alpha?: string | UiPart[];
    beta?: string | UiPart[];
    projectChat?: string;
    cakeChat?: string;
  },
  client: TestClientOverrides,
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/alpha" }), projectRecord({ path: "/beta" })],
    sessions: [
      sessionSummary({
        sessionId: "alpha",
        projectPath: "/alpha",
        workingDirectory: "/alpha-tree",
      }),
      sessionSummary({ sessionId: "beta", projectPath: "/beta", workingDirectory: "/beta-tree" }),
    ],
    client: {
      ...client,
      projectSessions: { open: async () => undefined, ...client.projectSessions },
      cakeChats: {
        open: async () => undefined,
        setUnread: async () => undefined,
        ...client.cakeChats,
      },
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
      artifacts: { effective: async () => [], ...client.artifacts },
    },
  });
  for (const [sessionId, text] of [
    ["alpha", texts.alpha],
    ["beta", texts.beta],
  ] as const) {
    if (text === undefined) continue;
    const session = fixture.root.sessionRegistry.load(sessionId, `/${sessionId}-tree`);
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: snapshot(sessionId, text),
    });
    session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  }
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      { sessionId: projectChatId, title: "Project Chat", projectPath: "/alpha" },
      { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
    ],
  });
  const chatId =
    texts.projectChat !== undefined
      ? projectChatId
      : texts.cakeChat !== undefined
        ? CAKE_CHAT_SESSION_ID
        : undefined;
  if (chatId) {
    const session = fixture.root.cakeChatCollectionStore.registry.load(chatId);
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: snapshot(chatId, texts.projectChat ?? texts.cakeChat!),
    });
    session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
    fixture.root.navigationStore.selectCakeChat(chatId);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(chatId);
  } else {
    fixture.root.navigationStore.selectProjectSession("alpha");
    fixture.root.projectWorkbenchStore.showLoadedSession("alpha");
    fixture.root.sessionLayoutStore.ensureSession("alpha");
    if (texts.beta !== undefined) fixture.root.sessionLayoutStore.splitFocused("beta", "x");
  }
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 160 }}>
      <RendererRoot
        rootStore={fixture.root}
        openExternalUrl={vi.fn()}
        openSession={vi.fn()}
        openSubagent={vi.fn()}
      />
    </VirtuosoMockContext.Provider>,
  );
  return {
    root: fixture.root,
    async focus(sessionId: string) {
      await act(async () =>
        fixture.root.navigationStore.focusSessionPane(
          fixture.root.sessionLayoutStore.paneForSession(sessionId)!.paneId,
        ),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

// Real RendererRoot -> production pane behavior -> ChatTranscript -> Markdown -> validated Client.
// These assert authority/resource bindings, not native focus, layout, scrolling or iframe execution.
it("loads identical relative names from each displayed working directory and keeps them on pane-selection changes", async () => {
  const readImage = vi.fn<Client["filesystem"]["readImage"]>(async (directory) => ({
    data: directory === "/alpha-tree" ? "AQID" : "BAUG",
    mimeType: "image/png",
  }));
  using fixture = renderResources(
    { alpha: "![Alpha image](screen.png)", beta: "![Beta image](screen.png)" },
    { filesystem: { readImage } },
  );
  const alpha = await screen.findByRole("img", { name: "Alpha image" });
  const beta = await screen.findByRole("img", { name: "Beta image" });
  expect(alpha.getAttribute("src")).toBe("data:image/png;base64,AQID");
  expect(beta.getAttribute("src")).toBe("data:image/png;base64,BAUG");
  expect(new Set(readImage.mock.calls.map(([directory]) => directory))).toEqual(
    new Set(["/alpha-tree", "/beta-tree"]),
  );
  await fixture.focus("alpha");
  const settledReads = readImage.mock.calls.length;
  await fixture.focus("beta");
  await fixture.focus("alpha");
  expect(readImage.mock.calls).toHaveLength(settledReads);
  expect(screen.getByRole("img", { name: "Alpha image" }).getAttribute("src")).toBe(
    "data:image/png;base64,AQID",
  );
  expect(screen.getByRole("img", { name: "Beta image" }).getAttribute("src")).toBe(
    "data:image/png;base64,BAUG",
  );
});

it("loads Project Chat images from its project without task-session catalog membership", async () => {
  const readImage = vi.fn<Client["filesystem"]["readImage"]>(async () => ({
    data: "AQID",
    mimeType: "image/png",
  }));
  using fixture = renderResources(
    { projectChat: "![Project image](screen.png)" },
    { filesystem: { readImage } },
  );
  expect(await screen.findByRole("img", { name: "Project image" })).toBeDefined();
  expect(fixture.root.sessionCatalogStore.find(projectChatId)).toBeUndefined();
  expect(readImage).toHaveBeenCalledWith("/alpha", "screen.png", expect.anything());
});

it("shows an unavailable image in global Cake Chat rather than falling back to a task's directory", async () => {
  const readImage = vi.fn<Client["filesystem"]["readImage"]>();
  using fixture = renderResources(
    { cakeChat: "![Global image](screen.png)" },
    { filesystem: { readImage } },
  );
  expect(await screen.findByText("Image not available: Global image")).toBeDefined();
  expect(fixture.root.sessionCatalogStore.find(CAKE_CHAT_SESSION_ID)).toBeUndefined();
  expect(readImage).not.toHaveBeenCalled();
});

it.each(["Markdown", "tool"] as const)(
  "authorizes %s artifact/widget state using each displayed public conversation, not the selected pane",
  async (surface) => {
    const stateRead = vi.fn<Client["artifacts"]["stateRead"]>(async ({ lineageId }) => ({
      lineageId,
      version: 0,
      value: null,
    }));
    const reference = "cake://artifact/report@r1";
    const content: string | UiPart[] =
      surface === "Markdown"
        ? `![Widget](${reference})`
        : [
            {
              id: "publication",
              kind: "tool",
              name: "cake",
              command: "artifacts.present",
              input: "",
              state: "success",
              artifactId: "report",
              artifactReference: reference,
            },
          ];
    using fixture = renderResources(
      { alpha: content, beta: content },
      {
        artifacts: {
          referenceMetadata: async (ref) => {
            const value = referenceMetadata(ref);
            return {
              ...value,
              revision: { ...value.revision, kind: "widget" },
              lineage: { ...value.lineage, latest: { ...value.lineage.latest, kind: "widget" } },
            };
          },
          readExact: async (id, revision) => {
            const value = artifactRevision(id, revision);
            return {
              ...value,
              metadata: { ...value.metadata, kind: "widget" },
              snapshot: {
                ...value.snapshot,
                kind: "widget",
                payload: {
                  language: "html",
                  source: "<p>Widget</p>",
                  brief: "Widget",
                  generationSessionId: "generator",
                  browser: { digest: "a".repeat(64) },
                },
              },
            };
          },
          stateRead,
        },
        inlineWidgets: {
          open: async () => ({
            token: "00000000-0000-4000-8000-000000000010",
            url: "cake-widget://document/00000000-0000-4000-8000-000000000010",
          }),
        },
      },
    );
    await waitFor(() =>
      expect(new Set(stateRead.mock.calls.map(([input]) => input.sessionId))).toEqual(
        new Set(["alpha", "beta"]),
      ),
    );
    await fixture.focus("alpha");
    await fixture.focus("beta");
    expect(new Set(stateRead.mock.calls.map(([input]) => input.sessionId))).toEqual(
      new Set(["alpha", "beta"]),
    );
  },
);
