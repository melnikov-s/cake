import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationState } from "../../../../src/ipc/session-contract";
import { EditorSettingsStore } from "../../../../src/renderer/stores/EditorSettingsStore";

function applicationState(editorCommand?: string): ApplicationState {
  return {
    schemaVersion: 1,
    projects: [],
    resolvedSessionIds: [],
    resolvedCakeChatSessionIds: [],
    trustedProjectPaths: [],
    editorCommand,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("EditorSettingsStore", () => {
  it("queues rapid edits and keeps the latest optimistic value", async () => {
    const first = deferred<ApplicationState>();
    const setEditorCommand = vi
      .fn<(command: string) => Promise<ApplicationState>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (command) => applicationState(command));
    const store = mount(createStore(EditorSettingsStore, { client: { setEditorCommand } }));

    const firstSave = store.setCommand("code --wait");
    const secondSave = store.setCommand("zed --wait");
    await vi.waitFor(() => expect(setEditorCommand).toHaveBeenCalledOnce());
    expect(store.command).toBe("zed --wait");

    first.resolve(applicationState("code --wait"));
    await Promise.all([firstSave, secondSave]);

    expect(setEditorCommand.mock.calls).toEqual([["code --wait"], ["zed --wait"]]);
    expect(store.command).toBe("zed --wait");
    expect(store.saving).toBe(false);
    store[Symbol.dispose]();
  });

  it("ignores stale application state while saving and restores the last confirmation on failure", async () => {
    const pending = deferred<ApplicationState>();
    const store = mount(
      createStore(EditorSettingsStore, {
        client: { setEditorCommand: vi.fn(() => pending.promise) },
      }),
    );
    store.applyApplicationState(applicationState("confirmed"));
    const save = store.setCommand("optimistic");

    store.applyApplicationState(applicationState("stale"));
    expect(store.command).toBe("optimistic");
    pending.reject(new Error("save failed"));
    await save;

    expect(store.command).toBe("confirmed");
    expect(store.error).toBe("save failed");
    expect(store.saving).toBe(false);
    store[Symbol.dispose]();
  });

  it("rejects late completion commits after disposal", async () => {
    const pending = deferred<ApplicationState>();
    const store = mount(
      createStore(EditorSettingsStore, {
        client: { setEditorCommand: vi.fn(() => pending.promise) },
      }),
    );
    const save = store.setCommand("optimistic");
    store[Symbol.dispose]();

    pending.resolve(applicationState("server"));
    await save;

    expect(store.command).toBe("optimistic");
  });
});
