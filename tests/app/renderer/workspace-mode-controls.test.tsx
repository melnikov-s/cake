/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { sessionSummary } from "./fixtures/catalog-fixtures";
import {
  editorLease,
  editorSessionId,
  renderEmbeddedEditor,
  deferredEditorOpen,
} from "./embedded-editor-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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

const currentBrowserState = {
  sessionId: editorSessionId,
  url: "https://user:password@example.com/current/page?token=secret#access_token=secret",
  title: "Do not serialize titles",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  inspecting: false,
};

// Reach the toolbar through the real App. Native browser/editor services alone are faked.
describe("app.state visible workspace metadata", () => {
  it("reads the current browser location, not the draft address or selected project", async () => {
    const open = vi.fn<Client["browser"]["open"]>(async () => currentBrowserState);
    const navigate = vi.fn<Client["browser"]["navigate"]>(async () => currentBrowserState);
    const editorStatus = vi.fn<Client["vscode"]["performEditorAction"]>();
    using fixture = renderEmbeddedEditor({
      browser: { open, navigate, updateBounds: async () => currentBrowserState },
      vscode: { performEditorAction: editorStatus },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Browser" }));
    fixture.measureWorkspace();
    await fixture.user.clear(screen.getByRole("textbox", { name: "Browser address" }));
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Browser address" }),
      "https://draft.invalid/",
    );
    const state = await fixture.appState();
    expect(state).toMatchObject({
      state: {
        workspaceView: {
          kind: "browser",
          sessionId: editorSessionId,
          status: "ready",
          url: "https://example.com/current/page",
        },
      },
    });
    expect(JSON.stringify(state)).not.toMatch(/password|secret|draft.invalid|Do not serialize/);
    expect(editorStatus).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    await fixture.user.click(screen.getByRole("button", { name: "Main" }));
    expect(await fixture.appState()).not.toHaveProperty("state.workspaceView");
  });

  it("reports browser loading without inventing the default address", async () => {
    let complete!: (state: typeof currentBrowserState) => void;
    const pending = new Promise<typeof currentBrowserState>((resolve) => {
      complete = resolve;
    });
    using fixture = renderEmbeddedEditor({
      browser: {
        open: () => pending,
        updateBounds: async () => currentBrowserState,
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Browser" }));
    fixture.measureWorkspace();
    const result = await fixture.appState();
    expect(result).toHaveProperty("state.workspaceView.status", "loading");
    expect(result).not.toHaveProperty("state.workspaceView.url");
    complete(currentBrowserState);
  });

  it("reports browser failure without exposing a retained URL or raw error", async () => {
    using fixture = renderEmbeddedEditor({
      browser: {
        open: async () => {
          throw new Error("https://user:password@example.com/?token=secret");
        },
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Browser" }));
    fixture.measureWorkspace();
    const result = await fixture.appState();
    expect(result).toHaveProperty("state.workspaceView.status", "unavailable");
    expect(JSON.stringify(result)).not.toMatch(/password|secret|localhost/);
  });

  it("reports all visible VS Code groups without file contents or background queries", async () => {
    const status = vi.fn<Client["vscode"]["performEditorAction"]>(async (): Promise<JsonValue> => ({
      action: "editor.status",
      active: { path: "left.ts" },
      visible: [
        { path: "src/left.ts", group: 1, active: true, content: "PRIVATE_CONTENT" },
        { path: "/outside/right.ts", group: 2, active: false },
      ],
    }));
    using fixture = renderEmbeddedEditor({
      vscode: { open: async () => editorLease("b"), performEditorAction: status },
    });
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    fixture.measureWorkspace();
    const result = await fixture.appState();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTENT");
    expect(result).toMatchObject({
      state: {
        workspaceView: {
          kind: "vscode",
          status: "ready",
          sessionId: editorSessionId,
          editors: [
            { path: "src/left.ts", group: 1, active: true },
            { path: "/outside/right.ts", group: 2, active: false },
          ],
        },
      },
    });
    expect(status).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(
      "/project",
      { type: "editor.status" },
      { signal: expect.any(AbortSignal) },
    );
    fixture.coverWorkspace();
    const covered = await fixture.appState();
    expect(covered).toMatchObject({ state: { selection: { kind: "settings" } } });
    expect(covered).not.toHaveProperty("state.workspaceView");
    expect(status).toHaveBeenCalledOnce();
  });

  it("does not return editor paths if the view is hidden while metadata is in flight", async () => {
    let complete!: (result: JsonValue) => void;
    let started!: () => void;
    const pending = new Promise<JsonValue>((resolve) => {
      complete = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    using fixture = renderEmbeddedEditor({
      vscode: {
        open: async () => editorLease("f"),
        performEditorAction: () => {
          started();
          return pending;
        },
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    fixture.measureWorkspace();
    const request = fixture.appState();
    await began;
    fixture.coverWorkspace();
    complete({ visible: [{ path: "no-longer-visible.ts", group: 1, active: true }] });
    const result = await request;
    expect(result).toHaveProperty("state.workspaceView.status", "hidden");
    expect(result).not.toHaveProperty("state.workspaceView.editors");
  });

  it("does not block orientation on editor initialization", async () => {
    const pending = deferredEditorOpen();
    const status = vi.fn<Client["vscode"]["performEditorAction"]>();
    using fixture = renderEmbeddedEditor({
      vscode: { open: () => pending.promise, performEditorAction: status },
    });
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    fixture.measureWorkspace();
    expect(await fixture.appState()).toMatchObject({
      state: {
        workspaceView: {
          kind: "vscode",
          status: "loading",
        },
      },
    });
    expect(status).not.toHaveBeenCalled();
    pending.resolve(editorLease("c"));
  });

  it("returns unavailable within a 200ms metadata budget even if the editor ignores cancellation", async () => {
    const status = vi.fn<Client["vscode"]["performEditorAction"]>(() => new Promise(() => {}));
    using fixture = renderEmbeddedEditor({
      vscode: { open: async () => editorLease("d"), performEditorAction: status },
    });
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    fixture.measureWorkspace();
    vi.useFakeTimers();
    try {
      let settled = false;
      const result = fixture.appState().then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(199);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({
        state: {
          workspaceView: {
            kind: "vscode",
            status: "unavailable",
          },
        },
      });
      expect(status.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([null, { visible: [] }, { visible: [{ path: 42 }] }, "rejected"])(
    "handles an unavailable, empty or invalid editor snapshot honestly: %j",
    async (snapshot) => {
      using fixture = renderEmbeddedEditor({
        vscode: {
          open: async () => editorLease("e"),
          performEditorAction: async () => {
            if (snapshot === "rejected") throw new Error("Companion unavailable");
            return snapshot;
          },
        },
      });
      await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
      await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
      fixture.measureWorkspace();
      const result = await fixture.appState();
      if (
        snapshot &&
        typeof snapshot === "object" &&
        "visible" in snapshot &&
        snapshot.visible.length === 0
      )
        expect(result).toHaveProperty("state.workspaceView.editors", []);
      else expect(result).toHaveProperty("state.workspaceView.status", "unavailable");
    },
  );
});

describe("Workspace mode navigation", () => {
  it("keeps one shared header row and control slots through Main, Browser and VS Code", async () => {
    using fixture = renderEmbeddedEditor({
      vscode: { open: async () => editorLease("a") },
      browser: {
        open: async () => currentBrowserState,
        updateBounds: async () => currentBrowserState,
      },
    });
    // jsdom checks shared layout wiring, not pixel geometry (covered by Electron).
    const layout = () => {
      const tools = screen.getByRole("group", { name: "Workspace tools" });
      const header = tools.closest("header")!;
      const modes = within(header).getByRole("group", { name: "Conversation workspace" });
      expect(
        within(modes)
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Main", "VS Code", "Browser"]);
      for (const button of within(modes).getAllByRole("button")) {
        expect(button.textContent).toBe("");
        expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      }
      expect(tools.classList.contains("border")).toBe(false);
      expect(modes.classList.contains("border")).toBe(true);
      expect(modes.classList.contains("bg-muted/65")).toBe(true);
      expect(modes.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
      for (const button of within(modes).getAllByRole("button")) {
        expect(button.classList.contains("aria-pressed:bg-card")).toBe(true);
        expect(button.classList.contains("aria-pressed:text-foreground")).toBe(true);
        expect(button.classList.contains("aria-pressed:text-accent")).toBe(false);
      }
      expect(header.parentElement?.getAttribute("data-slot")).toBe("shell-header");
      const actions = header.querySelector('[data-slot="workspace-actions"]')!;
      const center = header.querySelector('[data-slot="workspace-mode"]')!;
      expect(center.contains(modes)).toBe(true);
      expect(actions.contains(modes)).toBe(false);
      const utilities = [...actions.querySelectorAll("button")];
      expect(utilities.map((button) => button.getAttribute("aria-label"))).toEqual([
        "Review changes",
        "0 artifacts",
        "Side chats",
        "Terminal",
        "Work log display options",
      ]);
      const terminal = within(tools).getByRole("button", { name: "Terminal" });
      expect(modes.contains(terminal)).toBe(false);
      const sessionTools = screen.getByRole("group", { name: "Session tools" });
      expect(sessionTools.contains(terminal)).toBe(true);
      expect(
        within(sessionTools)
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["0 artifacts", "Side chats", "Terminal", "Work log display options"]);
      expect(sessionTools.contains(modes)).toBe(false);
      const globalPanel = screen.getByRole("button", { name: /^(Open|Close) Workspace$/ });
      expect(sessionTools.contains(globalPanel)).toBe(false);
      const separator = globalPanel.previousElementSibling!;
      expect(separator.getAttribute("data-slot")).toBe("workspace-tools-divider");
      expect(separator.getAttribute("aria-hidden")).toBe("true");
      expect(separator.classList.contains("w-px")).toBe(true);
      expect(tools.querySelector('[aria-hidden="true"].w-px')).toBeNull();
      expect(actions.classList.contains("overflow-x-auto")).toBe(true);
      // Actions stop short of the window-centered mode group.
      expect(actions.classList.contains("max-w-[calc(100%-var(--workspace-mode-clearance))]")).toBe(
        true,
      );
      expect(actions.classList.contains("justify-self-end")).toBe(true);
      expect(header.classList.contains("h-title-bar")).toBe(true);
      expect(header.classList.contains("flex-col")).toBe(false);
      expect(header.classList.contains("border-b")).toBe(true);
      expect(actions.querySelector("strong")).toBeNull();
      const breadcrumb = within(header).getByRole("navigation", {
        name: "Conversation breadcrumb",
      });
      expect(breadcrumb.classList.contains("flex-wrap")).toBe(false);
      expect(breadcrumb.classList.contains("overflow-hidden")).toBe(true);
      expect(breadcrumb.classList.contains("overflow-x-auto")).toBe(false);
      for (const button of within(breadcrumb).getAllByRole("button")) {
        expect(button.classList.contains("min-w-0")).toBe(true);
        expect(button.querySelector("span.truncate")).not.toBeNull();
      }
      return {
        header: header.className,
        titleRow: header.firstElementChild!.className,
        actions: actions.className,
        tools: tools.className,
        slots: [...tools.children].map((child) => child.className),
        center: center.className,
      };
    };
    expect(screen.getByRole("button", { name: "Main" }).getAttribute("aria-pressed")).toBe("true");
    const chatLayout = layout();
    await fixture.user.click(screen.getByRole("button", { name: "Browser" }));
    expect(await screen.findByRole("textbox", { name: "Browser address" })).toBeDefined();
    expect(layout()).toEqual(chatLayout);
    await fixture.user.click(screen.getByRole("button", { name: "Close Workspace" }));
    expect(layout()).toEqual(chatLayout);
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    await screen.findByTitle("VS Code workspace");
    fixture.measureWorkspace();
    await waitFor(() => expect(document.documentElement.dataset.titleBar).toBe("vscode"));
    expect(layout()).toEqual(chatLayout);
    await fixture.user.click(screen.getByRole("button", { name: "Main" }));
    expect(screen.getByRole("button", { name: "Main" }).getAttribute("aria-pressed")).toBe("true");
    expect(layout()).toEqual(chatLayout);
  });
  it("opens the worker CWD while retaining its owning project and draft across tool companions", async () => {
    const open = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
    using fixture = renderEmbeddedEditor(
      { vscode: { open } },
      {
        additionalSessions: [
          sessionSummary({
            sessionId: "worktree-worker",
            title: "Worktree worker",
            projectPath: "/project",
            workingDirectory: "/project-worktree",
          }),
        ],
      },
    );
    await fixture.user.click(screen.getByRole("button", { name: "Search sessions" }));
    await fixture.user.click(screen.getByRole("option", { name: /^Worktree worker / }));
    await within(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).findByRole(
      "button",
      { name: "Worktree worker" },
    );
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Message" }),
      "Keep this worker draft",
    );
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "/project-worktree",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      screen
        .getByRole("button", { name: "Open Project Chat for Project" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await fixture.user.click(screen.getByRole("button", { name: "Close Workspace" }));
    await fixture.user.click(screen.getByRole("button", { name: "Open Workspace" }));
    expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(
      "Keep this worker draft",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Main" }));
    expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(
      "Keep this worker draft",
    );
  });
  it.each(["Browser", "VS Code"] as const)(
    "selects %s without changing the conversation and keeps all workspace modes available",
    async (action) => {
      const browserState = {
        sessionId: editorSessionId,
        url: "http://localhost:3000/",
        title: "Local app",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        inspecting: false,
      };
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000001"),
      );
      const openEditor = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
      const openBrowser = vi.fn<Client["browser"]["open"]>(async () => browserState);
      using fixture = renderEmbeddedEditor({
        sessionChats: { prompt },
        vscode: { open: openEditor },
        browser: { open: openBrowser, updateBounds: async () => browserState },
      });
      await fixture.user.click(screen.getByRole("button", { name: action }));
      if (action === "VS Code") {
        await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
        expect(openEditor).toHaveBeenCalledOnce();
      } else {
        await waitFor(() =>
          expect(
            screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value,
          ).toBe(browserState.url),
        );
        expect(openBrowser).toHaveBeenCalledOnce();
      }
      expect(screen.getByRole("button", { name: action }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      const other = action === "VS Code" ? "Browser" : "VS Code";
      expect(screen.getByRole("button", { name: other })).toBeDefined();
      expect(screen.getByRole("button", { name: "Terminal" })).toBeDefined();
      await fixture.user.type(
        screen.getByRole("combobox", { name: "Message" }),
        "Continue in this workspace",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(prompt).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: editorSessionId,
            text: "Continue in this workspace",
            presentationMode: action === "Browser" ? "browser" : "vscode",
            responseMode: "text",
          }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      await fixture.user.click(screen.getByRole("button", { name: "Main" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Main" }).getAttribute("aria-pressed")).toBe(
          "true",
        ),
      );
      expect(screen.queryByTitle("VS Code workspace")).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Browser address" })).toBeNull();
      expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
      expect(screen.getByRole("button", { name: action })).toBeDefined();
    },
  );
});
