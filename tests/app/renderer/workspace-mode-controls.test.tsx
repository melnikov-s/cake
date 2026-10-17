/** @vitest-environment jsdom */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import {
  editorLease,
  editorSessionId,
  renderEmbeddedEditor,
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

// Reach the toolbar through the real App. Native browser/editor services alone are faked.
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
