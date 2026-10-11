/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function deferredOpen() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderCachedWorkbench(open: Client["projectSessions"]["open"]) {
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
    client: { projectSessions: { open } },
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
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

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

// Unlike an unhydrated destination (project-navigation-workflow), a cached
// conversation is selected immediately. Its runtime-open failure must attach to
// that visible chat, not the previous one; this is service/rendered-state proof,
// not native focus or keyboard correctness.
describe("Workbench cached conversation lifecycle", () => {
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
