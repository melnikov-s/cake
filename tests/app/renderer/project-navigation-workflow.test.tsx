/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import type { ConversationSnapshot } from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projects = ["alpha", "beta", "gamma"].map((name) =>
  projectRecord({ path: `/${name}`, name }),
);
const sessions = ["alpha", "beta"].map((name) =>
  sessionSummary({ sessionId: name, title: `${name} session`, projectPath: `/${name}` }),
);
function snapshot(sessionId: string): ConversationSnapshot {
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
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function renderNavigation(open: Client["projectSessions"]["open"] = async () => undefined) {
  const fixture = createRendererStoreFixture({
    projects,
    sessions,
    client: {
      projectSessions: { open },
      electron: { chooseProject: async () => "/beta" },
      workspaces: {
        inspect: async (request) => ({ ...request, trustRequired: false }),
        registerProject: async () => defaultApplicationState(),
        loadStagedSlashCommands: async () => [],
      },
    },
  });
  const publish = (id: string) =>
    applyConversationUpdate(fixture.models.projectConversation(id, `/${id}`), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: snapshot(id),
    });
  fixture.root.sessionRegistry.load("alpha", "/alpha");
  publish("alpha");
  fixture.root.appShellStore.selectProjectSession("alpha");
  fixture.root.projectWorkbenchStore.showLoadedSession("alpha");
  fixture.root.sessionLayoutStore.ensureSession("alpha");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    async hydrate(id: string) {
      await act(async () => publish(id));
    },
    async changeActivity() {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: sessions.map((session) => ({
            ...session,
            modifiedAt:
              session.sessionId === "beta" ? "2026-02-01T00:00:00.000Z" : session.modifiedAt,
          })),
          resolvedHasMoreByProject: {},
        }),
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

describe("Project navigation workflow", () => {
  it("selects the existing session when reopening a registered project", async () => {
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderNavigation(open);
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        { sessionId: "beta", workingDirectory: "/beta" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.hydrate("beta");
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    expect(screen.getAllByText("beta session").length).toBeGreaterThan(1);
  });
  it("keeps the current conversation until the requested session hydrates and supports returning to a cached session", async () => {
    const opening = deferred<void>();
    const open = vi.fn<Client["projectSessions"]["open"]>(() => opening.promise);
    using fixture = renderNavigation(open);
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(open).toHaveBeenCalledWith(
      { sessionId: "beta", workingDirectory: "/beta" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await act(async () => opening.resolve());
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.hydrate("beta");
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Go back in session history" }));
    expect(await screen.findByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    const calls = open.mock.calls.length;
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(open).toHaveBeenCalledTimes(calls);
  });

  it("retains the current project after an open failure and lets the user retry", async () => {
    const open = vi
      .fn<Client["projectSessions"]["open"]>()
      .mockRejectedValueOnce(new Error("Session temporarily unavailable"))
      .mockResolvedValue(undefined);
    using fixture = renderNavigation(open);
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    await fixture.hydrate("beta");
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("focuses the sidebar on a project without replacing the active conversation", async () => {
    using fixture = renderNavigation();
    await fixture.user.click(screen.getByRole("button", { name: "Focus on beta" }));
    expect(screen.queryByRole("button", { name: /^alpha session / })).toBeNull();
    expect(screen.getByRole("button", { name: /^beta session / })).toBeDefined();
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
  });

  it("reorders projects through drag and drop and retains that order when activity changes", async () => {
    using fixture = renderNavigation();
    const source = screen.getByRole("button", { name: "Start new chat in alpha" });
    const target = screen.getByRole("button", { name: "Start new chat in gamma" });
    const payload = new Map<string, string>();
    const dataTransfer = {
      types: ["application/x-cake-item"],
      setData: (type: string, value: string) => payload.set(type, value),
      getData: (type: string) => payload.get(type) ?? "",
    };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(target, { dataTransfer, clientY: 10 });
    fireEvent.dragEnd(source, { dataTransfer });
    const projectButtons = () =>
      screen
        .getAllByRole("button", { name: /^Collapse (alpha|beta|gamma)$/ })
        .map((button) => button.getAttribute("aria-label"));
    expect(projectButtons()).toEqual(["Collapse beta", "Collapse gamma", "Collapse alpha"]);
    await fixture.changeActivity();
    expect(projectButtons()).toEqual(["Collapse beta", "Collapse gamma", "Collapse alpha"]);
  });

  it("keeps project order stable when activity changes", async () => {
    using fixture = renderNavigation();
    const projectButtons = () =>
      screen
        .getAllByRole("button", { name: /^Collapse (alpha|beta|gamma)$/ })
        .map((button) => button.getAttribute("aria-label"));
    expect(projectButtons()).toEqual(["Collapse alpha", "Collapse beta", "Collapse gamma"]);
    await fixture.changeActivity();
    expect(projectButtons()).toEqual(["Collapse alpha", "Collapse beta", "Collapse gamma"]);
  });
});
