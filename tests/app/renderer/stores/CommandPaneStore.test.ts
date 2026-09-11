import { child, createStore, mount, Store } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { CommandPaneStore } from "../../../../src/renderer/stores/CommandPaneStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { ActiveProjectSessionContext } from "../../../../src/renderer/stores/context/ActiveProjectSessionContext";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";

class CommandPaneHarnessStore extends Store<{
  client: Client;
  operations: SessionOperationCoordinatorStore;
  setDraft(value: string): void;
}> {
  [ClientContext.provide]() {
    return this.props.client;
  }

  [ActiveProjectSessionContext.provide]() {
    return { sessionId: "source", workingDirectory: "/project" };
  }

  @child
  get commandPane(): CommandPaneStore {
    return createStore(CommandPaneStore, {
      operations: this.props.operations,
      editorText: (entryId) => (entryId === "user-entry" ? "Original prompt" : undefined),
      setDraft: this.props.setDraft,
      requestComposerFocus: vi.fn(),
      reportError: vi.fn(),
    });
  }
}

const disposables: Array<{ [Symbol.dispose](): void }> = [];

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable[Symbol.dispose]();
});

function setup() {
  const navigate = vi.fn(async () => undefined);
  const setDraft = vi.fn();
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const root = mount(
    createStore(CommandPaneHarnessStore, {
      client: { projectSessions: { navigate } } as unknown as Client,
      operations,
      setDraft,
    }),
  );
  disposables.push(root, operations);
  return { store: root.commandPane, navigate, setDraft };
}

describe("CommandPaneStore tree navigation", () => {
  it("asks for summary policy and sends custom focus to Pi", async () => {
    const { store, navigate, setDraft } = setup();

    expect(store.requestNavigation("user-entry")).toBe(true);
    expect(store.navigationPrompt?.summaryMode).toBe("none");
    store.selectNavigationSummary("custom");
    store.setNavigationInstructions("  Preserve the API decisions  ");

    expect(await store.confirmNavigation()).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      {
        sessionId: "source",
        entryId: "user-entry",
        summarize: true,
        customInstructions: "Preserve the API decisions",
      },
      expect.any(Object),
    );
    expect(setDraft).toHaveBeenCalledWith("Original prompt");
  });

  it("can navigate without summarizing", async () => {
    const { store, navigate } = setup();

    store.requestNavigation("assistant-entry");
    await store.confirmNavigation();

    expect(navigate).toHaveBeenCalledWith(
      { sessionId: "source", entryId: "assistant-entry", summarize: false },
      expect.any(Object),
    );
  });
});
