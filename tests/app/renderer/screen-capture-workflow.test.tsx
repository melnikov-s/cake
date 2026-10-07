/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function emptyConversation(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
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
  };
}
function renderCapture(startScreenCapture: Client["electron"]["startScreenCapture"]) {
  const configureScreenCapture = vi.fn<Client["electron"]["configureScreenCapture"]>(
    async () => {},
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [
      sessionSummary({ sessionId: "alpha", projectPath: "/project" }),
      sessionSummary({ sessionId: "beta", projectPath: "/project" }),
    ],
    client: {
      electron: { startScreenCapture, configureScreenCapture },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  const capture = fixture.root.screenCaptureStore;
  for (const id of ["alpha", "beta"]) {
    fixture.root.sessionRegistry.load(id, "/project");
    applyConversationUpdate(fixture.models.projectConversation(id, "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: emptyConversation(id),
    });
  }
  const select = (id: string) => {
    fixture.root.appShellStore.selectProjectSession(id);
    fixture.root.projectWorkbenchStore.showLoadedSession(id);
    fixture.root.sessionLayoutStore.ensureSession(id);
  };
  select("alpha");
  fixture.root.sessionRegistry
    .findSession("alpha")!
    .conversationSessionStore.composerStore.draftStore.setText("Existing draft");
  fixture.root.appShellStore.showSettings();
  fixture.root.settingsStore.selectPage("screen-capture");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    root: fixture.root,
    models: fixture.models,
    capture,
    configureScreenCapture,
    select,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function expectExistingDraft() {
  const input = screen.getByRole("combobox", { name: "Message" });
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected chat composer");
  expect(input.value).toBe("Existing draft");
}
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
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

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
describe("Screen capture attachment workflow", () => {
  it("uses the last chat when no conversation is active and appends without replacing or sending the draft", async () => {
    const start = vi.fn<Client["electron"]["startScreenCapture"]>(async () => png);
    using fixture = renderCapture(start);
    act(() => {
      fixture.root.appShellStore.showWorkbench();
      fixture.root.appShellStore.showSettings();
    });
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    act(() => fixture.select("alpha"));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
  });

  it("pins the destination at activation even if navigation changes before capture completes", async () => {
    let complete!: (value: string) => void;
    const result = new Promise<string>((resolve) => {
      complete = resolve;
    });
    using fixture = renderCapture(async () => result);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    act(() => fixture.select("beta"));
    await act(async () => complete(png));
    expect(screen.queryByRole("button", { name: /^View Screenshot-/ })).toBeNull();
    act(() => fixture.select("alpha"));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
    expectExistingDraft();
  });

  it("leaves the existing draft untouched when the native experience is cancelled", async () => {
    using fixture = renderCapture(async () => undefined);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByRole("button", { name: /^View Screenshot-/ })).toBeNull();
    expectExistingDraft();
  });

  it("reports native failures without destroying the draft and supports another capture", async () => {
    const start = vi
      .fn<Client["electron"]["startScreenCapture"]>()
      .mockRejectedValueOnce(new Error("Allow screen recording"))
      .mockResolvedValueOnce(png);
    using fixture = renderCapture(start);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(await screen.findByText("Allow screen recording")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(await screen.findByRole("button", { name: /^View Screenshot-/ })).toBeDefined();
  });

  it("does not attach a finished capture to a chat resolved during capture", async () => {
    let complete!: (value: string) => void;
    const result = new Promise<string>((resolve) => {
      complete = resolve;
    });
    using fixture = renderCapture(async () => result);
    await fixture.user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    act(() => {
      const summary = fixture.models.sessionCatalog.sessions.find(
        (session) => session.sessionId === "alpha",
      );
      if (!summary) throw new Error("Missing session");
      summary.resolved = true;
    });
    await act(async () => complete(png));
    expect(await screen.findByText("The destination chat is no longer editable.")).toBeDefined();
  });

  it("configures the resized-image limit and disables the global shortcut through Settings", async () => {
    using fixture = renderCapture(async () => undefined);
    await fixture.user.selectOptions(screen.getByLabelText("Maximum image dimension"), "1024");
    await waitFor(() =>
      expect(fixture.configureScreenCapture).toHaveBeenLastCalledWith(
        { shortcut: "Mod+Shift+6", maxDimension: 1024 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(fixture.configureScreenCapture).toHaveBeenLastCalledWith(
        { shortcut: "", maxDimension: 1024 },
        expect.anything(),
      ),
    );
    expect(screen.getByRole("button", { name: "Screen capture shortcut" }).textContent).toContain(
      "Not assigned",
    );
  });
});
