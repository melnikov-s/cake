/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import type { StoreEvent } from "../../../src/renderer/events/StoreEvent";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

function deferredOpen() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderCachedWorkbench(
  open: Client["projectSessions"]["open"],
  nativeEditor = false,
  client: TestClientOverrides = {},
) {
  const summaries = ["alpha", "beta"].map((name) =>
    sessionSummary({
      sessionId: name,
      title: `${name} conversation`,
      projectPath: `/${name}`,
      projectName: name,
    }),
  );
  const fixture = createRendererStoreFixture({
    projects: ["alpha", "beta"].map((name) => projectRecord({ path: `/${name}`, name })),
    sessions: summaries,
    client: {
      ...client,
      projectSessions: { open, ...client.projectSessions },
      vscode: {
        open: async () => undefined,
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        updateSelectionHighlights: async () => undefined,
        setTheme: async () => undefined,
        ...client.vscode,
      },
    },
  });
  for (const summary of summaries) {
    fixture.root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(summary.sessionId, summary.workingDirectory),
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: summary.sessionId,
          sessionFile: `/sessions/${summary.sessionId}.jsonl`,
          parts: [],
          models: [],
          model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      },
    );
  }
  fixture.root.navigationStore.selectProjectSession("alpha");
  fixture.root.projectWorkbenchStore.showLoadedSession("alpha");
  fixture.root.sessionLayoutStore.ensureSession("alpha");
  if (nativeEditor) {
    fixture.root.sessionRegistry.findSession("alpha")!.workspaceChatSidebarVisible = false;
    fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore.applyState({
      status: "ready",
    });
  }
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    hostEditorRequest(
      event: Extract<
        StoreEvent,
        { type: "embedded-editor-side-chat-requested" | "embedded-editor-annotation-requested" }
      >,
    ) {
      // Same delivery point as observeVscodeEvents; native editor selection and
      // transport delivery are outside this in-process workflow's proof.
      act(() => fixture.root.projectWorkbenchStore.receive(event));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

async function renderRestoredWorkbench(client: TestClientOverrides) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
    client,
    snapshot: {
      state: {},
      children: {
        appShellStore: {
          state: {
            selection: { kind: "project-session", sessionId: "session-1" },
            activeConversation: { kind: "project-session", sessionId: "session-1" },
          },
          children: {},
        },
      },
    },
  });
  // This is the real renderer bootstrap entry point, not a simulated user control.
  await act(async () => fixture.root.initialize());
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
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

// Unlike an unhydrated destination (project-navigation-workflow), a cached
// conversation is selected immediately. Its runtime-open failure must attach to
// that visible chat, not the previous one; this is service/rendered-state proof,
// not native focus or keyboard correctness.
describe("Workbench conversation lifecycle", () => {
  it("re-authorizes a restored workspace before opening its conversation and lets the user decline", async () => {
    const inspect = vi.fn<Client["workspaces"]["inspect"]>(async (input) => ({
      ...input,
      trustRequired: true,
    }));
    const open = vi.fn<Client["projectSessions"]["open"]>();
    const respondToTrust = vi.fn<Client["workspaces"]["respondToTrust"]>(async () => undefined);
    using fixture = await renderRestoredWorkbench({
      workspaces: { inspect, respondToTrust },
      projectSessions: { open },
    });
    const dialog = screen.getByRole("alertdialog", { name: "Trust this workspace?" });
    expect(
      within(dialog).getByText(/\/project contains project-local executable Pi resources/),
    ).toBeDefined();
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(open).not.toHaveBeenCalled();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(respondToTrust).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/project",
        approved: false,
        operationId: expect.any(String),
      }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("routes editor requests only to their working directory and replaces a selection chat with its source attachment", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderCachedWorkbench(async () => undefined, true, {
      sessionChats: { prompt },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    expect(screen.getByRole("region", { name: "VS Code workspace" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    const selection = {
      path: "src/main.ts",
      startLine: 4,
      startColumn: 2,
      endLine: 5,
      endColumn: 8,
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
    };
    fixture.hostEditorRequest({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/elsewhere",
      ...selection,
    });
    expect(screen.queryByText("Chat about selection")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    fixture.hostEditorRequest({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/alpha",
      ...selection,
    });
    expect(screen.getByText("Chat about selection")).toBeDefined();
    expect(screen.getByText("src/main.ts · L5–6")).toBeDefined();
    fixture.hostEditorRequest({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/elsewhere",
      ...selection,
      comment: "Ignore this other workspace",
    });
    expect(screen.getByText("Chat about selection")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Remove src/main.ts#L5-L6" })).toBeNull();
    fixture.hostEditorRequest({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/alpha",
      ...selection,
      comment: "Why is this here?",
    });
    expect(screen.queryByText("Chat about selection")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove src/main.ts#L5-L6" })).toBeDefined();
    expect(screen.getByText("src/main.ts#L5-L6")).toBeDefined();
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Message" }),
      "Explain this source",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "alpha",
        text: "Explain this source",
        attachments: [
          {
            kind: "source",
            name: "src/main.ts",
            location: { path: "src/main.ts", range: { start: { line: 4 }, end: { line: 5 } } },
            selectedText: selection.selectedText,
            comment: "Why is this here?",
          },
        ],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove src/main.ts#L5-L6" })).toBeNull(),
    );
  });

  it("shows a cached destination's open error in its chat, preserves drafts and clears the error on navigation and retry", async () => {
    const failedOpen = deferredOpen();
    const retry = deferredOpen();
    const open = vi
      .fn<Client["projectSessions"]["open"]>()
      .mockImplementationOnce(() => failedOpen.promise)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => retry.promise);
    using fixture = renderCachedWorkbench(open);
    const input = () => screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    const choose = (name: string) =>
      fixture.user.click(
        screen.getByRole("button", { name: new RegExp(`^${name} conversation `) }),
      );

    await fixture.user.type(input(), "Alpha unsent work");
    await choose("beta");
    await waitFor(() => expect(input().placeholder).toBe("Ask Cake to work in beta…"));
    expect(screen.getAllByText("beta conversation").length).toBeGreaterThan(1);
    await fixture.user.type(input(), "Beta unsent work");
    await act(async () => failedOpen.reject(new Error("Beta runtime unavailable")));
    const error = await screen.findByRole("alert");
    expect(within(error).getByText("Beta runtime unavailable")).toBeDefined();
    await fixture.user.click(within(error).getByText("Technical details"));
    expect(within(error).getByText(/Context: Opening Project Session/)).toBeDefined();
    expect(input().value).toBe("Beta unsent work");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);

    await choose("alpha");
    await waitFor(() => expect(input().placeholder).toBe("Ask Cake to work in alpha…"));
    expect(input().value).toBe("Alpha unsent work");
    expect(screen.queryByText("Beta runtime unavailable")).toBeNull();

    await choose("beta");
    await waitFor(() => expect(input().placeholder).toBe("Ask Cake to work in beta…"));
    expect(input().value).toBe("Beta unsent work");
    expect(screen.queryByText("Beta runtime unavailable")).toBeNull();
    await act(async () => retry.resolve());
    expect(input().value).toBe("Beta unsent work");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(open.mock.calls.map(([request]) => request.sessionId)).toEqual([
      "beta",
      "alpha",
      "beta",
    ]);
    expect(open).toHaveBeenLastCalledWith(
      { sessionId: "beta", workingDirectory: "/beta" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
