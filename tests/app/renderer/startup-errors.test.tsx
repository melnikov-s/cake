/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../../src/renderer/components/app";
import { StartupError } from "../../../src/renderer/components/startup-error";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import type { TestClientOverrides } from "./test-client";

beforeEach(() => {
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

function restoredSession(client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake" })],
    sessions: [sessionSummary({ sessionId: "restored", projectPath: "/cake" })],
    client,
  });
  const { root } = fixture;
  root.sessionRegistry.load("restored", "/cake");
  root.appShellStore.selectProjectSession("restored");
  root.projectWorkbenchStore.showLoadedSession("restored");
  root.sessionLayoutStore.ensureSession("restored");
  const view = render(
    <StoreProvider store={root}>
      <App />
    </StoreProvider>,
  );
  return {
    ...fixture,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("replaces restored-session loading with the observation failure, then recovers on a snapshot", async () => {
  using fixture = restoredSession();
  expect(screen.getByText("Opening session")).toBeDefined();
  const conversation = fixture.models.projectConversation("restored", "/cake");
  await act(async () => {
    conversation.observationError = "Pi failed to initialize the session";
  });
  expect(screen.getByRole("alert").textContent).toContain("Pi failed to initialize the session");
  expect(screen.queryByText("Opening session")).toBeNull();
  await act(async () =>
    applyConversationUpdate(conversation, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "restored",
        sessionFile: "/sessions/restored.jsonl",
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
    }),
  );
  expect(
    await screen.findByRole("heading", { name: /What should we build in.*cake/ }),
  ).toBeDefined();
  expect(screen.queryByText("Pi failed to initialize the session")).toBeNull();
});

it("shows a restored project's inspection failure in its already-mounted conversation pane", async () => {
  using fixture = restoredSession({
    workspaces: {
      inspect: async () => {
        throw new Error("Cannot inspect /cake: permission denied");
      },
    },
  });
  await act(async () => {
    await fixture.root.initialize();
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Cannot inspect /cake: permission denied",
  );
  expect(screen.queryByText("Opening session")).toBeNull();
  expect(screen.getByRole("button", { name: "Copy full error details" })).toBeDefined();
});

it("shows bootstrap failure details and a reload action before the Store tree is available", () => {
  const error = new Error("Desktop host configuration could not be loaded");
  render(<StartupError error={error} />);
  expect(screen.getByRole("heading", { name: "Cake could not start" })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain(error.message);
  expect(screen.getByRole("button", { name: "Copy full error details" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Reload Cake" })).toBeDefined();
});
