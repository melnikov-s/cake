/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { sessionSummary } from "./fixtures/catalog-fixtures";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import {
  deferredEditorOpen,
  editorLease,
  editorSessionId,
  editorWorkingDirectory,
  renderEmbeddedEditor,
} from "./embedded-editor-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  // Register observers without fabricating native geometry or an editor implementation.
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function workspaceFrame() {
  return screen.queryByTitle<HTMLIFrameElement>("VS Code workspace");
}
function backToAgentButton() {
  // The workspace toolbar and error card both expose the production return action.
  return screen.getAllByRole("button", { name: "Back to agent" })[0]!;
}

function deferredCompletion<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function bootstrapBoundary() {
  const inspection = deferredCompletion<Awaited<ReturnType<Client["workspaces"]["inspect"]>>>();
  const registration = deferredCompletion<ReturnType<typeof defaultApplicationState>>();
  const mainOpen = deferredCompletion<void>();
  const inspect = vi.fn<Client["workspaces"]["inspect"]>(() => inspection.promise);
  const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(
    () => registration.promise,
  );
  const openSession = vi.fn<Client["projectSessions"]["open"]>(() => mainOpen.promise);
  return {
    client: {
      workspaces: { inspect, registerProject },
      projectSessions: { open: openSession },
    },
    openSession,
    mainOpen,
    async accept() {
      await act(async () =>
        inspection.resolve({ ...inspect.mock.calls[0]![0], trustRequired: false }),
      );
      await waitFor(() => expect(registerProject).toHaveBeenCalledTimes(1));
      await act(async () => registration.resolve(defaultApplicationState()));
    },
  };
}

async function hydrateBootstrap(
  boundary: ReturnType<typeof bootstrapBoundary>,
  fixture: ReturnType<typeof renderEmbeddedEditor>,
) {
  await waitFor(() => expect(boundary.openSession).toHaveBeenCalledTimes(1));
  fixture.hydrate();
  await act(async () => {
    boundary.mainOpen.resolve();
    await fixture.initialization;
  });
}

const sourceControlButton = () =>
  screen.getByRole("button", { name: "Open workspace changes in VS Code" });

describe("Embedded editor workflow", () => {
  it.each(["vscode", "text"] as const)(
    "routes chat range/diff links to %s before any editor launch",
    async (viewer) => {
      const location = {
        kind: "working-directory" as const,
        path: "src/app.ts",
        view: "changes" as const,
        base: "HEAD~1",
        range: { start: { line: 1 }, end: { line: 2 } },
      };
      const prepare = vi.fn<Client["filesystem"]["prepareFileLocation"]>(async () =>
        viewer === "vscode"
          ? { viewer, location }
          : {
              viewer,
              path: "/authorized-external/app.ts",
              content: "first line\nexternal selected line\nthird line",
            },
      );
      const open = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
      const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
        outcome: { view: "changes" },
        locations: [],
      }));
      using fixture = renderEmbeddedEditor(
        { filesystem: { prepareFileLocation: prepare }, vscode: { open, reveal } },
        {
          parts: [
            {
              id: "file-link",
              kind: "text",
              role: "assistant",
              status: "complete",
              text: "[Inspect source](src/app.ts?view=changes&base=HEAD~1#L2-L3)",
            },
          ],
        },
      );
      await fixture.user.click(await screen.findByRole("link", { name: "Inspect source" }));
      await waitFor(() =>
        expect(prepare).toHaveBeenCalledWith(
          {
            workspacePath: editorWorkingDirectory,
            originatingDirectory: editorWorkingDirectory,
            location,
          },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      if (viewer === "text") {
        const dialog = await screen.findByRole("dialog", {
          name: /\/authorized-external\/app\.ts\?view=changes/,
        });
        expect(
          within(dialog).getByText(/Diff unavailable outside the selected project/),
        ).toBeDefined();
        expect(within(dialog).getByText("external selected line").className).toContain("bg-accent");
        expect(open).not.toHaveBeenCalled();
        expect(reveal).not.toHaveBeenCalled();
        expect(screen.queryByText(/File is outside the selected project/)).toBeNull();
      } else {
        await waitFor(() =>
          expect(reveal).toHaveBeenCalledWith(editorWorkingDirectory, location, expect.any(Object)),
        );
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
      }
    },
  );

  it.each(["vscode", "text", "range"] as const)(
    "opens Markdown via %s with explicit source access",
    async (viewer) => {
      const markdown = "# Report\n\n**Readable findings**\n\n- One\n- Two";
      const location = {
        kind: "working-directory" as const,
        path: "report.md",
        ...(viewer === "range" ? { range: { start: { line: 2 } } } : {}),
      };
      const prepare = vi.fn<Client["filesystem"]["prepareFileLocation"]>(async () =>
        viewer === "vscode"
          ? { viewer, location }
          : { viewer: "text", path: "/external/report.md", content: markdown },
      );
      const open = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
      const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
        outcome: { view: "file" },
        locations: [],
      }));
      using fixture = renderEmbeddedEditor(
        { filesystem: { prepareFileLocation: prepare }, vscode: { open, reveal } },
        {
          parts: [
            {
              id: "markdown-link",
              kind: "text",
              role: "assistant",
              status: "complete",
              text: `[Read report](report.md${viewer === "range" ? "#L3" : ""})`,
            },
          ],
        },
      );
      await fixture.user.click(await screen.findByRole("link", { name: "Read report" }));
      if (viewer === "vscode") {
        await waitFor(() =>
          expect(reveal).toHaveBeenCalledWith(editorWorkingDirectory, location, expect.any(Object)),
        );
        return;
      }
      const dialog = await screen.findByRole("dialog", { name: /\/external\/report.md/ });
      if (viewer === "range") {
        expect(within(dialog).getByText("**Readable findings**").className).toContain("bg-accent");
      } else {
        expect(within(dialog).getByRole("heading", { name: "Report" })).toBeDefined();
        expect(within(dialog).getByText("Readable findings").getAttribute("data-streamdown")).toBe(
          "strong",
        );
        expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
        await fixture.user.click(within(dialog).getByRole("button", { name: "Show source" }));
        expect(within(dialog).getByText(/# Report/).textContent).toBe(markdown);
        await fixture.user.click(within(dialog).getByRole("button", { name: "Show Markdown" }));
        expect(within(dialog).getByRole("heading", { name: "Report" })).toBeDefined();
      }
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("discards pending file routing when the selected project changes", async () => {
    const pending =
      deferredCompletion<Awaited<ReturnType<Client["filesystem"]["prepareFileLocation"]>>>();
    const prepare = vi.fn<Client["filesystem"]["prepareFileLocation"]>(() => pending.promise);
    const open = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
    using fixture = renderEmbeddedEditor(
      { filesystem: { prepareFileLocation: prepare }, vscode: { open } },
      {
        additionalSessions: [
          sessionSummary({
            sessionId: "other-project",
            title: "Other project",
            projectPath: "/other",
            workingDirectory: "/other",
          }),
        ],
        parts: [
          {
            id: "file-link",
            kind: "text",
            role: "assistant",
            status: "complete",
            text: "[Inspect source](src/app.ts#L2)",
          },
        ],
      },
    );
    await fixture.user.click(await screen.findByRole("link", { name: "Inspect source" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    await fixture.user.click(screen.getByRole("button", { name: /^Other project / }));
    await act(async () =>
      pending.resolve({
        viewer: "text",
        path: "/old-project/app.ts",
        content: "stale external content",
      }),
    );
    expect(screen.queryByText("stale external content")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
  it("preserves one pending Source Control open through same-target bootstrap reauthorization and hydration", async () => {
    const boundary = bootstrapBoundary();
    const pending = deferredEditorOpen();
    const lease = editorLease("a");
    const open = vi.fn<Client["vscode"]["open"]>(() => pending.promise);
    const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
    using fixture = renderEmbeddedEditor(
      { ...boundary.client, vscode: { open, openSourceControl } },
      { bootstrap: true },
    );

    await fixture.user.click(sourceControlButton());
    expect(open).toHaveBeenCalledTimes(1);
    expect(openSourceControl).not.toHaveBeenCalled();
    await boundary.accept();
    expect(open).toHaveBeenCalledTimes(1);
    expect(openSourceControl).not.toHaveBeenCalled();
    await hydrateBootstrap(boundary, fixture);
    expect(open).toHaveBeenCalledTimes(1);
    expect(openSourceControl).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(lease);
      await pending.promise;
    });
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(lease.endpoint));
    await waitFor(() => expect(openSourceControl).toHaveBeenCalledTimes(1));
    expect(openSourceControl).toHaveBeenCalledWith(
      editorWorkingDirectory,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("preserves the current editor when hydration precedes accepted same-target reauthorization", async () => {
    const boundary = bootstrapBoundary();
    const pending = deferredEditorOpen();
    const lease = editorLease("b");
    const open = vi.fn<Client["vscode"]["open"]>(() => pending.promise);
    const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
    using fixture = renderEmbeddedEditor(
      { ...boundary.client, vscode: { open, openSourceControl } },
      { bootstrap: true },
    );
    await fixture.user.click(sourceControlButton());
    fixture.hydrate();
    await boundary.accept();
    await act(async () => fixture.initialization);
    expect(boundary.openSession).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(openSourceControl).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(lease);
      await pending.promise;
    });
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(lease.endpoint));
    await waitFor(() => expect(openSourceControl).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("restores an initially saved IDE preference when no editor is visible yet", async () => {
    const boundary = bootstrapBoundary();
    const lease = editorLease("b");
    const open = vi.fn<Client["vscode"]["open"]>(async () => lease);
    const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
    using fixture = renderEmbeddedEditor(
      { ...boundary.client, vscode: { open, openSourceControl } },
      { bootstrap: true, savedIde: true },
    );
    expect(open).not.toHaveBeenCalled();
    await boundary.accept();
    await hydrateBootstrap(boundary, fixture);
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(lease.endpoint));
    expect(open).toHaveBeenCalledTimes(1);
    expect(openSourceControl).not.toHaveBeenCalled();
  });

  it.each(["hide", "disconnect"] as const)(
    "does not revive a pending Source Control intent after explicit %s during reauthorization",
    async (cancellation) => {
      const boundary = bootstrapBoundary();
      const pending = deferredEditorOpen();
      const lease = editorLease("c");
      const open = vi.fn<Client["vscode"]["open"]>(() => pending.promise);
      const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
      const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
      using fixture = renderEmbeddedEditor(
        { ...boundary.client, vscode: { open, openSourceControl, release } },
        { bootstrap: true },
      );
      await fixture.user.click(sourceControlButton());
      if (cancellation === "hide") await fixture.user.click(backToAgentButton());
      else fixture.disconnected();
      await boundary.accept();
      await hydrateBootstrap(boundary, fixture);
      await act(async () => {
        pending.resolve(lease);
        await pending.promise;
      });
      await waitFor(() => expect(release).toHaveBeenCalledWith(lease.id));
      expect(open).toHaveBeenCalledTimes(1);
      expect(openSourceControl).not.toHaveBeenCalled();
      expect(workspaceFrame()).toBeNull();
      if (cancellation === "disconnect")
        expect(screen.getByText(/Connection lost\. Return to agent/)).toBeDefined();
      else expect(screen.getByRole("button", { name: "Open VS Code" })).toBeDefined();
    },
  );

  it.each(["hide", "disconnect"] as const)(
    "drops the older SCM intent when it settles while the reopened editor is pending after %s",
    async (cancellation) => {
      const boundary = bootstrapBoundary();
      const oldOpen = deferredEditorOpen();
      const reopened = deferredEditorOpen();
      const stale = editorLease("d");
      const current = editorLease("e");
      const open = vi
        .fn<Client["vscode"]["open"]>()
        .mockImplementationOnce(() => oldOpen.promise)
        .mockImplementationOnce(() => reopened.promise);
      const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
      const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
      using fixture = renderEmbeddedEditor(
        { ...boundary.client, vscode: { open, openSourceControl, release } },
        { bootstrap: true },
      );
      await fixture.user.click(sourceControlButton());
      if (cancellation === "disconnect") fixture.disconnected();
      await fixture.user.click(backToAgentButton());
      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      expect(open).toHaveBeenCalledTimes(2);
      await boundary.accept();
      await hydrateBootstrap(boundary, fixture);
      await act(async () => {
        oldOpen.resolve(stale);
        await oldOpen.promise;
      });
      await waitFor(() => expect(release).toHaveBeenCalledWith(stale.id));
      expect(openSourceControl).not.toHaveBeenCalled();
      await act(async () => {
        reopened.resolve(current);
        await reopened.promise;
      });
      await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint));
      expect(open).toHaveBeenCalledTimes(2);
      expect(openSourceControl).not.toHaveBeenCalled();
    },
  );

  it.each([editorWorkingDirectory, "/other"])(
    "cancels the old SCM intent when selecting another session in %s",
    async (workingDirectory) => {
      const pending = deferredEditorOpen();
      const stale = editorLease("f");
      const open = vi.fn<Client["vscode"]["open"]>(() => pending.promise);
      const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
      const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
      using fixture = renderEmbeddedEditor(
        { vscode: { open, openSourceControl, release } },
        {
          additionalSessions: [
            sessionSummary({
              sessionId: "other-session",
              title: "Other conversation",
              projectPath: workingDirectory,
              workingDirectory,
            }),
          ],
        },
      );
      await fixture.user.click(sourceControlButton());
      await fixture.user.click(screen.getByRole("button", { name: /^Other conversation / }));
      await act(async () => {
        pending.resolve(stale);
        await pending.promise;
      });
      await waitFor(() => expect(release).toHaveBeenCalledWith(stale.id));
      expect(open).toHaveBeenCalledTimes(1);
      expect(openSourceControl).not.toHaveBeenCalled();
      expect(workspaceFrame()).toBeNull();
      expect(
        screen.getByPlaceholderText(
          `Ask Cake to work in ${workingDirectory === editorWorkingDirectory ? "Project" : "Other"}…`,
        ),
      ).toBeDefined();
    },
  );
  it.each([false, true])(
    "asks Cake Chat to set up the backend and reports delivery failure=%s",
    async (fails) => {
      const start = vi.fn<Client["cakeChats"]["start"]>(async () => {
        if (fails) throw new Error("Setup chat unavailable");
        return TurnId.make("setup-turn");
      });
      using fixture = renderEmbeddedEditor({
        vscode: { open: async () => undefined },
        cakeChats: { start },
      });
      fixture.state({ status: "missing" });
      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      await fixture.user.click(screen.getByRole("button", { name: "Ask Cake to set this up" }));
      await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const request = start.mock.calls[0]![0];
      expect(request.text).toContain("backend's actual operating system");
      expect(request.text).toContain("Remote desktops require code-server");
      expect(request.text).toContain(`Project: ${editorWorkingDirectory}`);
      expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
      if (fails) expect(await screen.findByText("Setup chat unavailable")).toBeDefined();
      else expect(screen.queryByText("Setup chat unavailable")).toBeNull();
    },
  );

  it("keeps native companion context scoped to the active workspace and clears it without closing the IDE", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => TurnId.make("context-turn"));
    const open = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
    using fixture = renderEmbeddedEditor({
      vscode: { open },
      sessionChats: { prompt },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()).not.toBeNull());
    fixture.nativeEvent({
      type: "embedded-editor-selection",
      workspacePath: editorWorkingDirectory,
      path: "src/active.ts",
      startLine: 2,
      endLine: 4,
    });
    expect(screen.getByRole("button", { name: /Remove.*active.ts/ })).toBeDefined();
    fixture.nativeEvent({
      type: "embedded-editor-selection",
      workspacePath: "/other-project",
      path: "other.ts",
      startLine: 0,
      endLine: 0,
    });
    fixture.nativeEvent({
      type: "embedded-editor-selection-cleared",
      workspacePath: "/other-project",
    });
    expect(screen.getByRole("button", { name: /Remove.*active.ts/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Remove.*other.ts/ })).toBeNull();
    fixture.nativeEvent({
      type: "embedded-editor-toggle-chat",
      workspacePath: editorWorkingDirectory,
    });
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    expect(workspaceFrame()).not.toBeNull();
    fixture.nativeEvent({
      type: "embedded-editor-toggle-chat",
      workspacePath: editorWorkingDirectory,
    });
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(open).toHaveBeenCalledTimes(1);
    fixture.nativeEvent({
      type: "embedded-editor-selection-cleared",
      workspacePath: editorWorkingDirectory,
    });
    expect(screen.queryByRole("button", { name: /Remove.*active.ts/ })).toBeNull();
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "No stale source");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "No stale source", attachments: [] }),
        expect.any(Object),
      ),
    );
    await fixture.user.click(backToAgentButton());
    expect(workspaceFrame()).toBeNull();
    expect(screen.getByRole("button", { name: "Open VS Code" })).toBeDefined();
  });

  it("replaces diff-side context, preserves the document snapshot on send and clears it on editor changes", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("00000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderEmbeddedEditor({
      vscode: { open: async () => editorLease("a") },
      sessionChats: { prompt },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()).not.toBeNull());
    const before = {
      document: {
        uri: "git:/project/src/active.ts?HEAD",
        side: "before" as const,
        range: { start: { line: 2, column: 3 }, end: { line: 5, column: 0 } },
      },
      selectedText: "deleted revision text\n",
    };
    const after = {
      document: {
        uri: "file:///project/src/active.ts",
        side: "after" as const,
        range: { start: { line: 2, column: 1 }, end: { line: 4, column: 5 } },
      },
      selectedText: "modified unsaved text",
    };
    const select = (diff: typeof before | typeof after) =>
      fixture.nativeEvent({
        type: "embedded-editor-selection",
        workspacePath: editorWorkingDirectory,
        path: "src/active.ts",
        startLine: 2,
        endLine: 4,
        diff,
      });
    const send = async (text: string) => {
      await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), text);
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    };
    select(before);
    select(after);
    select(after);
    expect(screen.getAllByRole("button", { name: /Remove.*active.ts/ })).toHaveLength(1);
    await send("Explain the modified side");
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt.mock.calls[0]![0].attachments).toEqual([
      {
        kind: "source",
        name: "src/active.ts",
        document: after.document,
        selectedText: after.selectedText,
        location: { path: "src/active.ts", range: { start: { line: 2 }, end: { line: 4 } } },
      },
    ]);
    expect(screen.queryByRole("alert")?.textContent).toBeUndefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe("");
    select(before);
    await send("Explain the deleted side");
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls[1]![0].attachments).toEqual([
      expect.objectContaining({
        document: before.document,
        selectedText: before.selectedText,
      }),
    ]);
    select(after);
    fixture.nativeEvent({
      type: "embedded-editor-selection-cleared",
      workspacePath: editorWorkingDirectory,
    });
    expect(screen.queryByRole("button", { name: /Remove.*active.ts/ })).toBeNull();
    await send("No stale diff selection");
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
    expect(prompt.mock.calls[2]![0].attachments).toEqual([]);
  });

  it("projects an active session's discussion annotations into the opened editor", async () => {
    const updateAnnotations = vi.fn<Client["vscode"]["updateAnnotations"]>(async () => undefined);
    using fixture = renderEmbeddedEditor(
      { vscode: { open: async () => editorLease("a"), updateAnnotations } },
      {
        threads: [
          {
            id: "thread-a",
            parentSessionId: editorSessionId,
            workingDirectory: editorWorkingDirectory,
            anchor: {
              view: "file",
              path: "src/app.ts",
              start: { diffLine: 3, newLine: 4 },
              end: { diffLine: 5, newLine: 6 },
              selectedText: "return value;",
              contextBefore: "",
              contextAfter: "",
              diff: "",
            },
            parts: [
              {
                id: "question",
                kind: "text",
                role: "user",
                text: "Why is this needed?",
                status: "complete",
              },
              {
                id: "answer",
                kind: "text",
                role: "assistant",
                text: "It preserves state.",
                status: "complete",
              },
            ],
            status: "open",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    );
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()).not.toBeNull());
    await waitFor(() =>
      expect(updateAnnotations).toHaveBeenCalledWith(
        editorWorkingDirectory,
        {
          sessionId: editorSessionId,
          annotations: [
            {
              id: "thread-a",
              location: {
                path: "src/app.ts",
                range: {
                  start: { line: 3, column: undefined },
                  end: { line: 5, column: undefined },
                },
              },
              status: "answered",
              replyCount: 1,
              preview: "Why is this needed?",
            },
          ],
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("offers backend setup when missing, displays a failed download and retries before explicitly reopening", async () => {
    // Only the viewing-device capability is controlled; no editor implementation is mocked.
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Linux");
    const lease = editorLease("b");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(lease);
    let finishInstall!: () => void;
    const installing = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const install = vi
      .fn<Client["vscode"]["install"]>()
      .mockRejectedValueOnce(new Error("Download unavailable"))
      .mockImplementationOnce(async () => {
        fixture.state({ status: "downloading", message: "Fetching backend editor" });
        await installing;
        fixture.state({ status: "ready" });
      });
    using fixture = renderEmbeddedEditor({ vscode: { open, install } });
    fixture.state({ status: "missing" });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    expect(screen.getByText("Full VS Code editing")).toBeDefined();
    expect(screen.getByText(/The editor runs on Cake’s backend/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Ask Cake to set this up" })).toBeDefined();
    expect(workspaceFrame()).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Download openvscode-server" }));
    expect(await screen.findByText("Download unavailable")).toBeDefined();
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("button", { name: "Ask Cake to set this up" })).toBeDefined();

    await fixture.user.click(screen.getByRole("button", { name: "Download openvscode-server" }));
    expect(await screen.findByText("Installing VS Code")).toBeDefined();
    expect(screen.getByText("Fetching backend editor")).toBeDefined();
    expect(screen.queryByText("Download unavailable")).toBeNull();
    expect(install).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishInstall();
      await installing;
    });
    await waitFor(() => expect(screen.queryByText("Installing VS Code")).toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
    await fixture.user.click(backToAgentButton());
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(lease.endpoint));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens the workspace, tolerates advisory sync failures and requires an explicit reopen after disconnect", async () => {
    const first = editorLease("a");
    const second = editorLease("b");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
    const setTheme = vi
      .fn<Client["vscode"]["setTheme"]>()
      .mockRejectedValueOnce(new Error("Theme RPC disconnected"))
      .mockResolvedValue(undefined);
    const updateAnnotations = vi
      .fn<Client["vscode"]["updateAnnotations"]>()
      .mockRejectedValueOnce(new Error("annotation unavailable"))
      .mockResolvedValue(undefined);
    using fixture = renderEmbeddedEditor({
      vscode: { open, release, setTheme, updateAnnotations },
    });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(first.endpoint));
    expect(open).toHaveBeenCalledWith(
      editorWorkingDirectory,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await waitFor(() => expect(setTheme).toHaveBeenCalledTimes(1));
    expect(setTheme).toHaveBeenCalledWith(
      "light",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(updateAnnotations).toHaveBeenCalledWith(
      editorWorkingDirectory,
      { sessionId: editorSessionId, annotations: [] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByText("Theme RPC disconnected")).toBeNull();
    expect(screen.queryByText("annotation unavailable")).toBeNull();
    expect(workspaceFrame()?.getAttribute("src")).toBe(first.endpoint);

    fixture.disconnected();
    expect(workspaceFrame()).toBeNull();
    expect(
      screen.getByText("Connection lost. Return to agent and reopen VS Code after reconnecting."),
    ).toBeDefined();
    fixture.state({ status: "ready" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(workspaceFrame()).toBeNull();

    await fixture.user.click(backToAgentButton());
    expect(screen.getByRole("button", { name: "Open VS Code" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(second.endpoint));
    expect(open).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(updateAnnotations).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(setTheme).toHaveBeenCalledTimes(2));
    await fixture.user.click(backToAgentButton());
    expect(workspaceFrame()).toBeNull();
    expect(release).toHaveBeenCalledWith(second.id);
    // The disconnected transport already revoked the first scoped lease.
    expect(release).not.toHaveBeenCalledWith(first.id);
  });

  it.each(["rejected open", "malformed endpoint"] as const)(
    "shows a %s failure and retries through the agent toolbar",
    async (failure) => {
      const good = editorLease("c");
      const malformed = {
        ...editorLease("d"),
        endpoint: `${editorLease("d").endpoint}?redirect=elsewhere`,
      };
      const open = vi.fn<Client["vscode"]["open"]>();
      if (failure === "rejected open")
        open.mockRejectedValueOnce(new Error("Editor service unavailable"));
      else open.mockResolvedValueOnce(malformed);
      open.mockResolvedValueOnce(good);
      const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
      using fixture = renderEmbeddedEditor({ vscode: { open, release } });

      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      const message =
        failure === "rejected open"
          ? "Editor service unavailable"
          : "Invalid editor lease endpoint";
      expect(await screen.findByText(message)).toBeDefined();
      expect(screen.getByText("VS Code could not open")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Ask Cake to set this up" })).toBeNull();
      expect(workspaceFrame()).toBeNull();
      if (failure === "malformed endpoint") expect(release).toHaveBeenCalledWith(malformed.id);
      // Exercise the failure card's own return action, not just the workspace toolbar.
      await fixture.user.click(
        within(screen.getByRole("alert")).getByRole("button", { name: "Back to agent" }),
      );
      expect(screen.queryByText("VS Code could not open")).toBeNull();
      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(good.endpoint));
      expect(screen.queryByText(message)).toBeNull();
      expect(open).toHaveBeenCalledTimes(2);
    },
  );

  it("releases a late acquisition after disconnect without presenting it over the reconnected workspace", async () => {
    const pending = deferredEditorOpen();
    const stale = editorLease("e");
    const current = editorLease("f");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(current);
    const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
    using fixture = renderEmbeddedEditor({ vscode: { open, release } });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(workspaceFrame()).toBeNull();
    fixture.disconnected();
    await fixture.user.click(backToAgentButton());
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint));
    await act(async () => {
      pending.resolve(stale);
      await pending.promise;
    });
    await waitFor(() => expect(release).toHaveBeenCalledWith(stale.id));
    expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps the reconnected workspace visible when an older acquisition rejects", async () => {
    const pending = deferredEditorOpen();
    const current = editorLease("a");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(current);
    using fixture = renderEmbeddedEditor({ vscode: { open } });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    fixture.disconnected();
    await fixture.user.click(backToAgentButton());
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint));
    await act(async () => {
      pending.reject(new Error("stale transport rejection"));
      await pending.promise.catch(() => undefined);
    });
    expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint);
    expect(screen.queryByText("stale transport rejection")).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
