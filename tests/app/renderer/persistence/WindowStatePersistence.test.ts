import { Schema } from "effect";
import { createStore, mount, snapshot, Store, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../../src/ipc/json-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { mountRootStore } from "../../../../src/renderer/bootstrap/mount-root-store";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { WindowStatePersistence } from "../../../../src/renderer/persistence/WindowStatePersistence";
import { extractSavedDrafts } from "../../../../src/services/storage/WindowStateStorage";

const workspace = "/projects/example";
const sessionId = "00000000-0000-4000-8000-000000000001";
const savedId = "00000000-0000-4000-8000-000000000002";
const attachment = { kind: "file" as const, name: "notes.txt", path: `${workspace}/notes.txt` };
const cleanups: (() => void)[] = [];

// Exercise the real Root/child Store snapshot contract, replacing only persistence I/O.
function harness({
  savedDraftsReady = false,
  loaded = { state: {}, children: {} },
}: {
  savedDraftsReady?: boolean;
  loaded?: StoreSnapshot;
} = {}) {
  const save = vi.fn<Client["windowState"]["save"]>(async () => undefined);
  const reportError = vi.fn();
  const client = { windowState: { save } } as unknown as Client;
  const models = RootProjection.create();
  const persistence = new WindowStatePersistence(client, reportError, savedDraftsReady);
  const root = mountRootStore(client, loaded, () => persistence.flush(), models);
  const session = root.sessionRegistry.pendingSessions.prepareStaged(workspace, sessionId);
  const draft = session.conversationSessionStore.composerStore.draftStore;
  draft.setText("unsent request");
  draft.attachments.push(attachment);
  root.appShellStore.selectProjectSession(sessionId);
  root.projectWorkbenchStore.showLoadedSession(sessionId);
  persistence.observe(root);
  cleanups.push(() => {
    persistence[Symbol.dispose]();
    root[Symbol.dispose]();
    models[Symbol.dispose]();
  });
  const expected = (): JsonValue => JSON.parse(JSON.stringify(toSnapshot(root)));
  return { root, draft, models, save, reportError, persistence, expected };
}

function deferredSave() {
  let resolve: () => void = () => {
    throw new Error("Save control not initialized");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("Save control not initialized");
  };
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class NormalizationStore extends Store {
  @snapshot value: unknown = {
    absent: undefined,
    numbers: [undefined, NaN, Infinity, -Infinity],
    date: new Date("2026-01-01T00:00:00.000Z"),
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WindowStatePersistence", () => {
  it("hydrates once, ignores transient changes, and saves the unchanged JSON-encodable Root payload", async () => {
    vi.useFakeTimers();
    const h = harness({
      loaded: {
        state: {},
        children: {
          projectCatalogStore: { state: { projectOrder: [workspace] }, children: {} },
        },
      },
    });
    expect(toSnapshot(h.root).children.projectCatalogStore).toMatchObject({
      state: { projectOrder: [workspace] },
    });
    expect(h.save).not.toHaveBeenCalled();
    h.draft.requestFocus();
    h.draft.error = "not persisted";
    await vi.advanceTimersByTimeAsync(180);
    expect(h.save).not.toHaveBeenCalled();

    h.draft.setText("updated");
    const expected = h.expected();
    await vi.advanceTimersByTimeAsync(180);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(expected);
    const payload = h.save.mock.calls[0]![0];
    expect(Schema.decodeUnknownSync(Schema.Json)(payload)).toEqual(payload);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(payload).toMatchObject({
      children: {
        appShellStore: { state: { selection: { kind: "project-session", sessionId } } },
        sessionRegistry: {
          children: {
            sessions: [
              {
                key: sessionId,
                children: {
                  conversationSessionStore: {
                    children: {
                      composerStore: {
                        children: {
                          draftStore: { state: { text: "updated", attachments: [attachment] } },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
  });

  it("debounces a burst to the latest navigation, draft, and attachment state", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.draft.setText("first");
    await vi.advanceTimersByTimeAsync(179);
    expect(h.save).not.toHaveBeenCalled();
    h.root.appShellStore.showWorkbench();
    h.draft.setText("latest");
    h.draft.attachments.push({
      ...attachment,
      name: "second.txt",
      path: `${workspace}/second.txt`,
    });
    await vi.advanceTimersByTimeAsync(179);
    expect(h.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(h.expected());
  });

  it("captures each queued flush before earlier saves finish and writes them in order", async () => {
    vi.useFakeTimers();
    const h = harness();
    const firstSave = deferredSave();
    h.save.mockImplementationOnce(() => firstSave.promise);
    h.draft.setText("first");
    const firstPayload = h.expected();
    const firstFlush = h.persistence.flush();
    await Promise.resolve();
    expect(h.save).toHaveBeenCalledExactlyOnceWith(firstPayload);

    h.draft.setText("second");
    const secondPayload = h.expected();
    const secondFlush = h.persistence.flush();
    h.draft.setText("third");
    h.draft.attachments.splice(0, 1);
    const thirdPayload = h.expected();
    const thirdFlush = h.persistence.flush();
    expect(h.save).toHaveBeenCalledOnce();
    firstSave.resolve();
    await Promise.all([firstFlush, secondFlush, thirdFlush]);
    expect(h.save.mock.calls.map(([payload]) => payload)).toEqual([
      firstPayload,
      secondPayload,
      thirdPayload,
    ]);
    await vi.advanceTimersByTimeAsync(180);
    expect(h.save).toHaveBeenCalledTimes(3);
  });

  it("flushes the latest state immediately and cancels its debounce timer", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.draft.setText("first");
    await vi.advanceTimersByTimeAsync(100);
    h.draft.setText("latest");
    await h.persistence.flush();
    expect(h.save).toHaveBeenCalledExactlyOnceWith(h.expected());
    await vi.advanceTimersByTimeAsync(180);
    expect(h.save).toHaveBeenCalledOnce();
  });

  it("disposal stops timer and queued saves without canceling an already-started save", async () => {
    vi.useFakeTimers();
    const h = harness();
    const firstSave = deferredSave();
    h.save.mockImplementationOnce(() => firstSave.promise);
    h.draft.setText("first");
    const firstFlush = h.persistence.flush();
    await Promise.resolve();
    expect(h.save).toHaveBeenCalledOnce();
    h.draft.setText("queued");
    const queuedFlush = h.persistence.flush();
    h.draft.setText("debounced");
    h.persistence[Symbol.dispose]();
    h.persistence[Symbol.dispose]();
    h.draft.setText("after disposal");
    firstSave.resolve();
    await Promise.all([firstFlush, queuedFlush, h.persistence.flush()]);
    await vi.advanceTimersByTimeAsync(180);
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("reports save failures and preserves later queued saves", async () => {
    vi.useFakeTimers();
    const h = harness();
    const firstSave = deferredSave();
    h.save.mockImplementationOnce(() => firstSave.promise);
    h.draft.setText("first");
    const firstFlush = h.persistence.flush();
    await Promise.resolve();
    h.draft.setText("second");
    const secondFlush = h.persistence.flush();
    const failure = new Error("disk unavailable");
    firstSave.reject(failure);
    await Promise.all([firstFlush, secondFlush]);
    expect(h.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(h.save).toHaveBeenLastCalledWith(h.expected());
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "strips only valid saved Drafts when migration readiness is %s",
    async (savedDraftsReady) => {
      vi.useFakeTimers();
      const h = harness({ savedDraftsReady });
      const saved = h.root.sessionRegistry.pendingSessions.prepare(workspace, savedId);
      const conversation = h.root.sessionRegistry.pendingSessions.conversation(saved.sessionId)!;
      conversation.createDraft("saved request", [attachment]);
      conversation.setName("Saved draft");
      const snapshot = h.expected();
      const extracted = extractSavedDrafts(snapshot);
      expect(extracted.records).toMatchObject([{ sessionId: savedId, text: "saved request" }]);
      await h.persistence.flush();
      expect(h.save).toHaveBeenCalledExactlyOnceWith(
        savedDraftsReady ? extracted.windowSnapshot : snapshot,
      );
      expect(extractSavedDrafts(h.save.mock.calls[0]![0]).records).toHaveLength(
        savedDraftsReady ? 0 : 1,
      );
      // Persistence never alters the mounted tree or its unsent composer state.
      expect(h.expected()).toEqual(snapshot);
      expect(h.draft.text).toBe("unsent request");
      expect(h.draft.attachments.slice()).toEqual([attachment]);
    },
  );

  it("preserves normalization of supported non-JSON snapshot values", async () => {
    const save = vi.fn<Client["windowState"]["save"]>(async () => undefined);
    const root = mount(createStore(NormalizationStore));
    const persistence = new WindowStatePersistence(
      { windowState: { save } } as unknown as Client,
      vi.fn(),
    );
    persistence.observe(root);
    cleanups.push(() => {
      persistence[Symbol.dispose]();
      root[Symbol.dispose]();
    });
    await persistence.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith({
      state: { value: { numbers: [null, null, null, null], date: "2026-01-01T00:00:00.000Z" } },
      children: {},
    });
  });
});
