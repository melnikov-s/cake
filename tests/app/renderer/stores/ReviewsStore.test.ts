import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import { ReviewsStore, type ReviewsStoreProps } from "../../../../src/renderer/stores/ReviewsStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createReviewsStore(
  overrides: Partial<
    Pick<
      DesktopClient,
      | "createReviewThread"
      | "replyReviewThread"
      | "resolveReviewThread"
      | "listReviewThreads"
      | "submitReviewThread"
    >
  > = {},
) {
  const applyReviewThreads = vi.fn();
  const upsertReviewThread = vi.fn();
  const registry = {
    applyReviewThreads,
    findModel: vi.fn(() => undefined),
    upsertReviewThread,
  } as unknown as SessionRegistryStore;
  const client = {
    createReviewThread: vi.fn(),
    replyReviewThread: vi.fn(),
    resolveReviewThread: vi.fn(),
    listReviewThreads: vi.fn(async () => []),
    submitReviewThread: vi.fn(async () => undefined),
    ...overrides,
  } as ReviewsStoreProps["client"];
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const store = mount(
    createStore(ReviewsStore, {
      client,
      sessionRegistry: registry,
      context: () => ({ sessionId: "session-1" }),
      model: () => undefined,
      thinkingLevel: () => undefined,
      configuration: () => undefined,
      operations,
    }),
  );
  return { store, operations, applyReviewThreads, upsertReviewThread };
}

describe("ReviewsStore", () => {
  it("lets only the latest thread load commit for a session", async () => {
    const first = deferred<never[]>();
    const listReviewThreads = vi
      .fn<DesktopClient["listReviewThreads"]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([]);
    const { store, operations, applyReviewThreads } = createReviewsStore({ listReviewThreads });

    const firstLoad = store.loadThreads("session-1");
    const secondLoad = store.loadThreads("session-1");
    await secondLoad;
    first.resolve([]);
    await firstLoad;

    expect(applyReviewThreads).toHaveBeenCalledOnce();
    expect(applyReviewThreads).toHaveBeenCalledWith("session-1", []);
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("lets only the latest resolution result commit for a thread", async () => {
    type Thread = Awaited<ReturnType<DesktopClient["resolveReviewThread"]>>;
    const first = deferred<Thread>();
    const reopened = { id: "thread-1", status: "open" } as Thread;
    const staleResolved = { id: "thread-1", status: "resolved" } as Thread;
    const resolveReviewThread = vi
      .fn<DesktopClient["resolveReviewThread"]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(reopened);
    const { store, operations, upsertReviewThread } = createReviewsStore({
      resolveReviewThread,
    });

    const resolving = store.resolveThread("thread-1", true);
    const reopening = store.resolveThread("thread-1", false);
    await reopening;
    first.resolve(staleResolved);
    await resolving;

    expect(upsertReviewThread).toHaveBeenCalledOnce();
    expect(upsertReviewThread).toHaveBeenCalledWith(reopened);
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("allows independent session loads to commit", async () => {
    const { store, operations, applyReviewThreads } = createReviewsStore();

    await Promise.all([store.loadThreads("session-1"), store.loadThreads("session-2")]);

    expect(applyReviewThreads).toHaveBeenCalledTimes(2);
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("removes correlated submissions from the longer-lived coordinator on disposal", async () => {
    const { store, operations } = createReviewsStore();
    await store.submitThread("thread-1", "session-1");
    expect(operations.active()).toHaveLength(1);

    store[Symbol.dispose]();

    expect(operations.active()).toHaveLength(0);
    operations[Symbol.dispose]();
  });
});
