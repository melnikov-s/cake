import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSessionStore } from "../../../../src/renderer/stores/ProjectSessionStore";
import { DrawControlStore } from "../../../../src/renderer/stores/DrawControlStore";

const board = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "background",
  title: "Board 1",
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function mountControls(sessions: ProjectSessionStore[], activeSessionId = "focused") {
  const openActiveDraw = vi.fn(async () => undefined);
  const root = mount(
    createStore(DrawControlStore, {
      sessions: () => sessions,
      findSession: (sessionId) => sessions.find((session) => session.sessionId === sessionId),
      isResolved: () => false,
      activeSessionId: () => activeSessionId,
      openActiveDraw,
    }),
  );
  return { root, store: root, openActiveDraw };
}

describe("DrawControlStore", () => {
  it("enters Draw for a background session without opening the active presentation", async () => {
    const initialize = vi.fn(async () => undefined);
    const showPresentation = vi.fn();
    const background = {
      sessionId: "background",
      presentationMode: "normal",
      showPresentation,
      drawStore: { initialize, activeBoard: undefined },
    } as unknown as ProjectSessionStore;
    const { root, store, openActiveDraw } = mountControls([background]);

    try {
      await expect(store.invoke("background", { _tag: "Enter" })).resolves.toMatchObject({
        ok: false,
        code: "BOARD_NOT_OPEN",
      });
      expect(showPresentation).toHaveBeenCalledWith("draw");
      expect(initialize).toHaveBeenCalledOnce();
      expect(openActiveDraw).not.toHaveBeenCalled();
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("does not acknowledge Apply until the Draw Store has saved its checkpoint", async () => {
    let finishApply!: () => void;
    const apply = vi.fn(
      () =>
        new Promise<{ createdIds: string[]; updatedIds: string[]; deletedIds: string[] }>(
          (resolve) => {
            finishApply = () =>
              resolve({ createdIds: ["shape:agent"], updatedIds: [], deletedIds: [] });
          },
        ),
    );
    const scene = {
      pageId: "page:default",
      viewportBounds: { x: 0, y: 0, width: 800, height: 600 },
      selectedShapeIds: ["shape:agent"],
      shapes: [],
      truncated: false,
    };
    const session = {
      sessionId: "background",
      presentationMode: "draw",
      drawStore: {
        activeBoard: board,
        apply,
        read: vi.fn(async () => scene),
        lastCheckpointId: "00000000-0000-4000-8000-000000000099",
      },
    } as unknown as ProjectSessionStore;
    const { root, store } = mountControls([session]);

    try {
      const response = store.invoke("background", {
        _tag: "Apply",
        operations: [
          {
            type: "create",
            shape: { id: "agent", type: "geo", x: 0, y: 0, width: 100, height: 80 },
          },
        ],
      });
      let settled = false;
      void response.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      finishApply();
      await expect(response).resolves.toMatchObject({
        ok: true,
        kind: "applied",
        checkpointId: "00000000-0000-4000-8000-000000000099",
      });
    } finally {
      root[Symbol.dispose]();
    }
  });
});
