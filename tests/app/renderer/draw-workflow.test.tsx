/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/ipc/conversation-data";
import type { DrawBoardMetadata } from "../../../src/services/storage/draw-board-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const firstBoard: DrawBoardMetadata = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "session-1",
  title: "Board 1",
  revision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const secondBoard: DrawBoardMetadata = {
  ...firstBoard,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Board 2",
};
function pendingDocument(): ReturnType<Client["draw"]["read"]> {
  return new Promise(() => {});
}

function renderDraw(client: TestClientOverrides, rememberedBoardId?: string) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({
        sessionId: "session-1",
        title: "Drawing conversation",
        projectPath: "/project",
      }),
    ],
    client: {
      ...client,
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
    },
  });
  const session = fixture.root.sessionRegistry.load("session-1", "/project");
  const snapshot: ConversationSnapshot = {
    sessionId: "session-1",
    sessionFile: "/sessions/session-1.jsonl",
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
  applyConversationUpdate(fixture.models.projectConversation("session-1", "/project"), {
    _tag: "Snapshot",
    revision: 1,
    snapshot,
  });
  // Seed the session's remembered window preference, not the board-opening behavior under test.
  session.drawStore.activeBoardId = rememberedBoardId;
  fixture.root.appShellStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  fixture.root.sessionLayoutStore.ensureSession("session-1");
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

// Covers board-opening service coordination and the real Draw workspace loading/error controls.
// Reads stay pending so these tests never start the native editor. A real export experiment failed
// in Excalidraw on missing Path2D and document.fonts.has; emulating its rendering is not a workflow
// test. Completed document/editor readiness, editing, exports and agent playback remain explicit
// backlog in stores/Draw*.test.ts rather than being claimed as jsdom coverage.
describe("Draw workflow", () => {
  it("requests the remembered board rather than the first board and blocks export while loading", async () => {
    const list = vi.fn<Client["draw"]["list"]>(async () => [firstBoard, secondBoard]);
    const read = vi.fn<Client["draw"]["read"]>(pendingDocument);
    using fixture = renderDraw({ draw: { list, read } }, secondBoard.id);

    await fixture.user.click(screen.getByRole("button", { name: "Open Cake Draw" }));
    const whiteboard = within(screen.getByRole("region", { name: "Cake Draw whiteboard" }));
    expect(whiteboard.getByText("Loading board")).toBeDefined();
    expect(
      whiteboard.getByRole("button", { name: "Export Cake Draw board" }).hasAttribute("disabled"),
    ).toBe(true);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(list).toHaveBeenCalledWith(
      { sessionId: "session-1" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(read).toHaveBeenCalledWith(
      { sessionId: "session-1", boardId: secondBoard.id },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("retries listing and then document reading without unnecessarily listing again", async () => {
    const list = vi.fn<Client["draw"]["list"]>(async () => [firstBoard]);
    list.mockRejectedValueOnce(new Error("list unavailable"));
    const read = vi.fn<Client["draw"]["read"]>(pendingDocument);
    read.mockRejectedValueOnce(new Error("read unavailable"));
    using fixture = renderDraw({ draw: { list, read } });

    await fixture.user.click(screen.getByRole("button", { name: "Open Cake Draw" }));
    const whiteboard = within(screen.getByRole("region", { name: "Cake Draw whiteboard" }));
    let alert = await whiteboard.findByRole("alert");
    expect(within(alert).getByText("Cake Draw could not open this board")).toBeDefined();
    expect(within(alert).getByText(/list unavailable/)).toBeDefined();
    expect(
      whiteboard.getByRole("button", { name: "Export Cake Draw board" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(read).not.toHaveBeenCalled();

    await fixture.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(whiteboard.getByRole("alert").textContent).toContain("read unavailable"),
    );
    alert = whiteboard.getByRole("alert");
    expect(list).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledOnce();
    await fixture.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(whiteboard.getByText("Loading board")).toBeDefined());
    expect(
      whiteboard.getByRole("button", { name: "Export Cake Draw board" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(
      { sessionId: "session-1", boardId: firstBoard.id },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(whiteboard.queryByText("Cake Draw could not open this board")).toBeNull();
  });

  it("creates a default board before requesting its document when the session has no boards", async () => {
    const create = vi.fn<Client["draw"]["create"]>(async () => firstBoard);
    const read = vi.fn<Client["draw"]["read"]>(pendingDocument);
    using fixture = renderDraw({ draw: { list: async () => [], create, read } });

    await fixture.user.click(screen.getByRole("button", { name: "Open Cake Draw" }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const whiteboard = within(screen.getByRole("region", { name: "Cake Draw whiteboard" }));
    expect(whiteboard.getByText("Loading board")).toBeDefined();
    expect(
      whiteboard.getByRole("button", { name: "Export Cake Draw board" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(create).toHaveBeenCalledWith(
      { sessionId: "session-1", title: "Board 1" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(
      { sessionId: "session-1", boardId: firstBoard.id },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!);
    expect(screen.getByRole("region", { name: "Cake Draw whiteboard" })).toBeDefined();
  });
});
