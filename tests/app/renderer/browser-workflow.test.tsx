/** @vitest-environment jsdom */
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserStateSnapshot, Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import type { StoreEvent } from "../../../src/renderer/events/StoreEvent";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const sessionId = "browser-session";
const ready: BrowserStateSnapshot = {
  sessionId,
  url: "http://localhost:3000/",
  title: "Local app",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  inspecting: false,
};

function renderBrowser(client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId, projectPath: "/project", title: "Browser task" })],
    client: {
      ...client,
      browser: {
        open: async () => ready,
        updateBounds: async () => ready,
        ...client.browser,
      },
    },
  });
  fixture.root.sessionRegistry.load(sessionId, "/project");
  applyConversationUpdate(fixture.models.projectConversation(sessionId, "/project"), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId,
      sessionFile: "/sessions/browser-session.jsonl",
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
    },
  });
  fixture.root.appShellStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  fixture.root.sessionLayoutStore.ensureSession(sessionId);
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    publishBrowserEvent(event: Extract<StoreEvent, { type: "browser-element-selected" }>) {
      // Native events enter the same real workbench routing used by application-events.ts.
      act(() => fixture.root.projectWorkbenchStore.receive(event));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
const address = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" });
beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
});

// These tests cover renderer workflows over a controlled native Browser Client, not Chromium
// navigation, native focus/keyboard capture, or real viewport geometry.
describe("Browser workspace workflow", () => {
  it("opens the session's browser, follows host navigation capabilities, and returns to chat", async () => {
    const open = vi.fn<Client["browser"]["open"]>(async () => ready);
    const action = vi
      .fn<Client["browser"]["action"]>()
      .mockResolvedValueOnce({ ...ready, loading: true })
      .mockResolvedValueOnce({ ...ready, canGoBack: true })
      .mockResolvedValueOnce({
        ...ready,
        url: "http://localhost:3000/previous",
        canGoForward: true,
      })
      .mockResolvedValueOnce({ ...ready, canGoBack: true });
    using fixture = renderBrowser({ browser: { open, action } });
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
    await waitFor(() => expect(address().value).toBe(ready.url));
    expect(open).toHaveBeenCalledWith(
      sessionId,
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("button", { name: "Back" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Forward" })).toHaveProperty("disabled", true);
    await fixture.user.click(screen.getByRole("button", { name: "Reload" }));
    await fixture.user.click(await screen.findByRole("button", { name: "Stop loading" }));
    await fixture.user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(address().value).toBe("http://localhost:3000/previous"));
    await fixture.user.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(address().value).toBe(ready.url));
    expect(action.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [sessionId, "reload"],
      [sessionId, "stop"],
      [sessionId, "back"],
      [sessionId, "forward"],
    ]);
    await fixture.user.click(screen.getByRole("button", { name: "Back to agent" }));
    expect(screen.queryByRole("textbox", { name: "Browser address" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it("adds only the active session's inspected element to the next chat message", async () => {
    const inspect = vi.fn<Client["browser"]["inspect"]>(async () => ({
      ...ready,
      inspecting: true,
    }));
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderBrowser({ browser: { inspect }, sessionChats: { prompt } });
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
    await fixture.user.click(screen.getByRole("button", { name: "Select an element" }));
    expect(
      screen.getByRole("button", { name: "Select an element" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(inspect).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const selected = {
      type: "browser-element-selected" as const,
      sessionId,
      url: "http://localhost:3000/settings",
      tagName: "button",
      selector: "#save",
      outerHTML: '<button id="save">Save</button>',
      text: "Save",
    };
    fixture.publishBrowserEvent({ ...selected, sessionId: "other-session", selector: "#other" });
    expect(screen.queryByRole("button", { name: /#other/ })).toBeNull();
    fixture.publishBrowserEvent(selected);
    expect(screen.getByRole("button", { name: /#save/ })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Select an element" }).getAttribute("aria-pressed"),
    ).toBe("false");
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Fix this button");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          text: "Fix this button",
          attachments: [
            {
              kind: "browser",
              name: "#save",
              url: selected.url,
              tagName: selected.tagName,
              selector: selected.selector,
              outerHTML: selected.outerHTML,
              text: selected.text,
            },
          ],
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.queryByRole("button", { name: /#save/ })).toBeNull();
  });

  it("keeps an open failure visible and permits a deliberate retry from chat", async () => {
    const open = vi
      .fn<Client["browser"]["open"]>()
      .mockRejectedValueOnce(new Error("Native browser unavailable"))
      .mockResolvedValueOnce(ready);
    using fixture = renderBrowser({ browser: { open } });
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
    expect(await screen.findByText("Native browser unavailable")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Back to agent" }));
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
    await waitFor(() => expect(address().value).toBe(ready.url));
    expect(screen.queryByText("Native browser unavailable")).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("navigates typed addresses and resolves backend preview paths through the native service", async () => {
    const navigate = vi.fn<Client["browser"]["navigate"]>(async (_id, url) => ({
      ...ready,
      url,
      canGoBack: true,
    }));
    const preview = vi.fn<Client["browser"]["preview"]>(async () => "http://127.0.0.1:4500/proxy/");
    using fixture = renderBrowser({ browser: { navigate, preview } });
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
    await fixture.user.clear(address());
    await fixture.user.type(address(), "http://localhost:5173/settings{Enter}");
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        sessionId,
        "http://localhost:5173/settings",
        expect.any(Object),
      ),
    );
    expect(address().value).toBe("http://localhost:5173/settings");
    await fixture.user.clear(address());
    await fixture.user.type(address(), "backend://localhost:5173/settings?tab=account#save{Enter}");
    await waitFor(() =>
      expect(address().value).toBe("http://127.0.0.1:4500/proxy/settings?tab=account#save"),
    );
    expect(preview).toHaveBeenCalledWith(
      sessionId,
      5173,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      sessionId,
      "http://127.0.0.1:4500/proxy/settings?tab=account#save",
      expect.any(Object),
    );
  });

  it("shows native service errors and rejects invalid backend preview addresses before navigation", async () => {
    const navigate = vi.fn<Client["browser"]["navigate"]>(async () => {
      throw new Error("Preview server refused connection");
    });
    const preview = vi.fn<Client["browser"]["preview"]>();
    using fixture = renderBrowser({ browser: { navigate, preview } });
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
    await fixture.user.clear(address());
    await fixture.user.type(address(), "http://localhost:5173/{Enter}");
    expect(await screen.findByText("Preview server refused connection")).toBeDefined();
    await fixture.user.clear(address());
    await fixture.user.type(address(), "backend://example.com:5173/{Enter}");
    expect(
      await screen.findByText("Backend previews require backend://localhost:<port>/"),
    ).toBeDefined();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(preview).not.toHaveBeenCalled();
  });
});
