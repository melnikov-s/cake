/** @vitest-environment jsdom */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
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
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
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
          paneId: expect.any(String),
        },
      },
    });
    expect(JSON.stringify(state)).not.toMatch(/password|secret|draft.invalid|Do not serialize/);
    expect(editorStatus).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    await fixture.user.click(screen.getByRole("button", { name: "Back to agent" }));
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
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
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
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
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
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
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
    expect(await fixture.appState()).toMatchObject({
      state: {
        workspaceView: {
          kind: "vscode",
          status: "hidden",
        },
      },
    });
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
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
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
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
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
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
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
      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
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
  it.each(["Open Browser Mode", "Open VS Code"] as const)(
    "replaces %s with a working return-to-Agent action and keeps the other mode available",
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
      if (action === "Open VS Code") {
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
      expect(screen.queryByRole("button", { name: action })).toBeNull();
      const other = action === "Open VS Code" ? "Open Browser Mode" : "Open VS Code";
      expect(screen.getByRole("button", { name: other })).toBeDefined();
      for (const name of ["Session tree", "Work log display options", "Terminal"])
        expect(screen.getByRole("button", { name })).toBeDefined();
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
            presentationMode: action === "Open Browser Mode" ? "browser" : "vscode",
            responseMode: "text",
          }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      await fixture.user.click(screen.getByRole("button", { name: "Back to agent" }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Back to agent" })).toBeNull(),
      );
      expect(screen.queryByTitle("VS Code workspace")).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Browser address" })).toBeNull();
      expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
      expect(screen.getByRole("button", { name: action })).toBeDefined();
    },
  );
});
