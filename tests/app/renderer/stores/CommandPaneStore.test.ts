import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import { CommandPaneStore } from "../../../../src/renderer/stores/CommandPaneStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createCommandPane(
  overrides: Partial<Pick<DesktopClient, "getChangelog" | "navigateSession">> = {},
) {
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const setDraft = vi.fn();
  const reportError = vi.fn();
  const client = {
    getChangelog: vi.fn(async () => undefined),
    navigateSession: vi.fn(async () => undefined),
    ...overrides,
  };
  const store = mount(
    createStore(CommandPaneStore, {
      client,
      operations,
      sessionContext: () => ({ sessionId: "session-1" }),
      editorText: (entryId) => `${entryId} draft`,
      setDraft,
      requestComposerFocus: vi.fn(),
      reportError,
    }),
  );
  return { store, operations, client, setDraft, reportError };
}

describe("CommandPaneStore", () => {
  it("ignores repeated changelog refreshes while one is active", async () => {
    const pending = deferred();
    const getChangelog = vi.fn(() => pending.promise);
    const { store, operations } = createCommandPane({ getChangelog });

    void store.refreshChangelog();
    await store.refreshChangelog();

    expect(getChangelog).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.waitFor(() => expect(store.changelogLoading).toBe(true));
    store[Symbol.dispose]();
    expect(operations.active()).toHaveLength(0);
    operations[Symbol.dispose]();
  });

  it("lets only the latest navigation restore a draft", async () => {
    const first = deferred();
    const second = deferred();
    const navigateSession = vi
      .fn<DesktopClient["navigateSession"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { store, operations, setDraft } = createCommandPane({ navigateSession });

    const firstNavigation = store.navigateTo("first");
    const secondNavigation = store.navigateTo("second");
    second.resolve();
    await secondNavigation;
    first.resolve();
    await firstNavigation;

    expect(setDraft).toHaveBeenCalledOnce();
    expect(setDraft).toHaveBeenCalledWith("second draft");
    for (const operationId of operations.active())
      store.receive({ type: "operation-completed", operationId });
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("owns failure cleanup for a correlated navigation", async () => {
    const { store, operations, reportError } = createCommandPane();
    await store.navigateTo("entry");
    const operationId = operations.active()[0]!;

    expect(
      store.receive({ type: "operation-failed", operationId, message: "navigation failed" }),
    ).toBe(true);

    expect(reportError).toHaveBeenCalledWith("navigation failed");
    expect(operations.active()).toEqual([]);
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
