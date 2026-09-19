/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawBoardToolbar } from "../../../src/renderer/components/draw-board-toolbar";
import type { DrawStore } from "../../../src/renderer/stores/DrawStore";

const boards = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "session-1",
    title: "Board 1",
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    sessionId: "session-1",
    title: "Board 2",
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("DrawBoardToolbar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("switches and creates durable boards through DrawStore", () => {
    const selectBoard = vi.fn();
    const createBoard = vi.fn();
    const store = {
      boards,
      activeBoardId: boards[0]!.id,
      activeBoard: boards[0],
      loading: false,
      saving: false,
      error: undefined,
      selectBoard,
      createBoard,
      renameBoard: vi.fn(),
      deleteBoard: vi.fn(),
    } as unknown as DrawStore;

    const onBack = vi.fn();
    act(() => root.render(<DrawBoardToolbar store={store} onBack={onBack} />));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Back to conversation"]')!
        .click(),
    );
    expect(onBack).toHaveBeenCalledOnce();
    const select = container.querySelector("select")!;
    act(() => {
      select.value = boards[1]!.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(selectBoard).toHaveBeenCalledWith(boards[1]!.id);

    const create = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New whiteboard"]',
    )!;
    act(() => create.click());
    expect(createBoard).toHaveBeenCalledOnce();
  });

  it("renames and deletes the active board with shared dialogs", () => {
    const renameBoard = vi.fn();
    const deleteBoard = vi.fn();
    const store = {
      boards,
      activeBoardId: boards[0]!.id,
      activeBoard: boards[0],
      loading: false,
      saving: false,
      error: undefined,
      selectBoard: vi.fn(),
      createBoard: vi.fn(),
      renameBoard,
      deleteBoard,
    } as unknown as DrawStore;

    act(() => root.render(<DrawBoardToolbar store={store} onBack={vi.fn()} />));
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Rename whiteboard"]')!.click(),
    );
    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Whiteboard name"]',
    )!;
    expect(input.value).toBe("Board 1");
    act(() =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "Rename")!
        .click(),
    );
    expect(renameBoard).toHaveBeenCalledWith(boards[0]!.id, "Board 1");

    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete whiteboard"]')!.click(),
    );
    act(() =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "Delete")!
        .click(),
    );
    expect(deleteBoard).toHaveBeenCalledWith(boards[0]!.id);
  });
});
