/** @vitest-environment jsdom */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderTranscriptContent as render } from "./render-transcript-content";
import userEvent from "@testing-library/user-event";
import { observer, StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { ProjectWorkspaceSurface } from "../../../src/renderer/components/project-workspace-surface";
import { projectTranscriptBehaviorFor } from "../../../src/renderer/lib/project-transcript-behavior";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("opens a parsed disjoint Markdown source link as two native-resolved selection pills and dismisses only the chosen range", async () => {
  // Register the real editor's browser observer without manufacturing any
  // viewport/Range rectangles. Native editor layout and focus are not asserted.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const reveal = vi.fn<Client["vscode"]["reveal"]>(async (_workspace, location) => ({
    outcome: { view: "file" },
    locations: (location.ranges ?? []).map((range) => ({
      kind: location.kind,
      path: location.path,
      view: "file",
      range,
    })),
  }));
  const highlights = vi.fn<Client["vscode"]["updateSelectionHighlights"]>(async () => undefined);
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "source-link", projectPath: "/project" })],
    client: {
      filesystem: { prepareFileLocation: async ({ location }) => ({ viewer: "vscode", location }) },
      vscode: {
        open: async () => undefined,
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        reveal,
        updateSelectionHighlights: highlights,
      },
    },
    snapshot: {
      state: {},
      children: {
        sidebarStore: { state: { visible: false }, children: {} },
        settingsStore: {
          state: {},
          children: {
            appearance: {
              state: { sessionAvatarsEnabled: false, projectAvatarsEnabled: false },
              children: {},
            },
          },
        },
      },
    },
  });
  const { root } = fixture;
  const session = root.sessionRegistry.load("source-link", "/project");
  applyConversationSnapshot(session.model, {
    sessionId: "source-link",
    sessionFile: "/project/source-link.jsonl",
    parts: [
      {
        id: "source-answer",
        entryId: "source-entry",
        kind: "text",
        role: "assistant",
        text: "Inspect [both functions](src/a.ts#L2,L9).",
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
  root.navigationStore.showLoadedProjectSession("source-link");
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  // The compact Chat is a real product mode for the starting reader. Once the
  // production source callback opens VS Code, render its actual workspace surface
  // (which owns EditorSelectionPills), not test-wired pills or parent callbacks.
  const SourceSelectionSurface = observer(function SourceSelectionSurface() {
    return session.presentationMode === "normal" ? (
      <Chat
        store={session.conversationSessionStore.chatStore}
        compact
        composerFocusEnabled={false}
        transcriptBehavior={projectTranscriptBehaviorFor(root, session)}
      />
    ) : (
      <ProjectWorkspaceSurface
        session={session}
        mode={session.presentationMode}
        browserMode={false}
      />
    );
  });
  const view = render(
    <StoreProvider store={root}>
      <SourceSelectionSurface />
    </StoreProvider>,
  );
  try {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "both functions" }));
    expect(await screen.findByRole("button", { name: "Reveal src/a.ts:2" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reveal src/a.ts:9" })).toBeDefined();
    expect(reveal).toHaveBeenCalledExactlyOnceWith(
      "/project",
      {
        kind: "working-directory",
        path: "src/a.ts",
        ranges: [
          { start: { line: 1 }, end: { line: 1 } },
          { start: { line: 8 }, end: { line: 8 } },
        ],
      },
      { signal: expect.any(AbortSignal) },
    );
    await user.click(screen.getByRole("button", { name: "Remove src/a.ts:2" }));
    expect(screen.queryByRole("button", { name: "Reveal src/a.ts:2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal src/a.ts:9" })).toBeDefined();
    await waitFor(() =>
      expect(highlights).toHaveBeenLastCalledWith(
        "/project",
        {
          locations: [
            {
              kind: "working-directory",
              path: "src/a.ts",
              view: "file",
              range: { start: { line: 8 }, end: { line: 8 } },
            },
          ],
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
  } finally {
    view.unmount();
  }
});
