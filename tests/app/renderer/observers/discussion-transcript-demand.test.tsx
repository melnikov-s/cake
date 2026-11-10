/** @vitest-environment jsdom */
import { Effect, Queue, Stream } from "effect";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import type {
  DiscussionThread,
  DiscussionThreadMetadata,
  DiscussionSessionUpdate,
} from "../../../../src/contracts/discussion-sessions/discussion-session-data";
import { ChatTranscript } from "../../../../src/renderer/components/chat-transcript";
import { observeApplicationEvents } from "../../../../src/renderer/observers/application-events";
import type { CakeEvent } from "../../../../src/contracts/application/cake-rpc-contract";
import { observeModels } from "../../../../src/renderer/observers/models";
import { applyDiscussionCatalogUpdate } from "../../../../src/renderer/reducers/DiscussionReducer";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

const thread = (parentSessionId: string, index: number): DiscussionThread => ({
  id: `${parentSessionId}-thread-${index}`,
  parentSessionId,
  sidecarSessionId: `${parentSessionId}-sidecar-${index}`,
  title: `Side chat ${index}`,
  workingDirectory: "/project",
  anchor: {
    path: "message",
    view: "message",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  },
  parts: [],
  status: "open",
  createdAt: "",
  updatedAt: "",
});
const snapshot = (sessionId: string) => ({
  sessionId,
  sessionFile: `/${sessionId}.jsonl`,
  parts: [
    {
      id: sessionId,
      entryId: "source-entry",
      kind: "text" as const,
      role: "assistant" as const,
      text: `Transcript ${sessionId}`,
      status: "complete" as const,
    },
  ],
  models: [],
  thinkingLevel: "off" as const,
  availableThinkingLevels: [],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

async function setup() {
  const fixture = createRendererStoreFixture({
    client: {
      cakeChats: {
        lookup: async ({ sessionId }) => ({
          sessionId,
          title: "Cake Chat",
          createdAt: "",
          modifiedAt: "",
          messageCount: 1,
          resolved: false,
          unread: false,
          running: false,
          unstarted: false,
        }),
      },
    },
  });
  await fixture.root.cakeChatCollectionStore.initialize();
  const parent = fixture.root.sessionRegistry.load("project-parent", "/project");
  const chat = fixture.root.cakeChatCollectionStore.registry.find(CAKE_CHAT_SESSION_ID)!;
  const threads = ["project-parent", CAKE_CHAT_SESSION_ID].flatMap((id) =>
    Array.from({ length: 15 }, (_, index) => thread(id, index)),
  );
  for (const id of ["project-parent", CAKE_CHAT_SESSION_ID]) {
    applyDiscussionCatalogUpdate(fixture.models.discussionCatalog(id), id, {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: id,
      threads: threads.filter((thread) => thread.parentSessionId === id),
    });
  }
  const metadata = Effect.runSync(Queue.unbounded<readonly DiscussionThreadMetadata[]>());
  const events = Effect.runSync(
    Queue.unbounded<Extract<CakeEvent, { type: "interview-requested" }>>(),
  );
  const ended: string[] = [];
  const starts: string[] = [];
  const observe = vi.fn(
    ({ parentSessionId, threadId }: { parentSessionId: string; threadId: string }) => {
      const record = threads.find((thread) => thread.id === threadId)!;
      const update: DiscussionSessionUpdate = {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          identity: {
            _tag: "DiscussionSession",
            sessionId: record.sidecarSessionId!,
            parentSessionId,
          },
          conversation: snapshot(record.sidecarSessionId!),
        },
      };
      return Stream.succeed(update).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(
          Effect.sync(() => {
            ended.push(threadId);
          }),
        ),
      );
    },
  );
  const runtime = observerRuntime(
    observerClient({
      events: { application: () => Stream.fromQueue(events) },
      projects: {
        observeCatalog: () => {
          starts.push("projects");
          return Stream.never;
        },
      },
      automations: { observe: () => Stream.never },
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      projectSessions: { observeCatalog: () => Stream.never, observeSignals: () => Stream.never },
      cakeChats: {
        observeCatalog: () => {
          starts.push("catalog");
          return Stream.never;
        },
        observeControls: () => Stream.never,
        observeSideChats: () => Stream.never,
        observeSideChatMetadata: () => Stream.fromQueue(metadata),
      },
      conversations: {
        observe: ({ sessionId }) => {
          starts.push(sessionId);
          return Stream.succeed({
            _tag: "Snapshot" as const,
            revision: 1,
            snapshot: snapshot(sessionId),
          }).pipe(Stream.concat(Stream.never));
        },
      },
      discussionSessions: {
        observe,
        observeCatalog: () => Stream.never,
        observeMetadata: () => Stream.never,
      },
      subagents: { observe: () => Stream.never, observeMetadata: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    }),
  );
  const stop = observeModels(runtime, fixture.models, fixture.root);
  return {
    fixture,
    runtime,
    events,
    parent,
    chat,
    metadata,
    observe,
    ended,
    starts,
    [Symbol.dispose]() {
      cleanup();
      stop();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

it("starts selected chat first and keeps thirty hidden sidecars cold while metadata and indicators update", async () => {
  using test = await setup();
  const { fixture, chat, observe, starts } = test;
  await vi.waitFor(() => expect(chat.model.observedSnapshotRevision).toBe(1));
  expect(starts[0]).toBe(CAKE_CHAT_SESSION_ID);
  expect(fixture.models.discussionConversations).toHaveLength(0);
  expect(chat.sideChats.discussionSessions).toHaveLength(0);
  expect(fixture.root.reviewsStore.discussionSessions).toHaveLength(0);
  expect(observe).not.toHaveBeenCalled();
  const record = thread(CAKE_CHAT_SESSION_ID, 8);
  await act(async () => {
    await Effect.runPromise(
      Queue.offer(test.metadata, [{ ...record, title: "Background title changed", running: true }]),
    );
  });
  await vi.waitFor(() => expect(chat.sideChatStreaming(record.id)).toBe(true));
  expect(
    fixture.root.conversationNavigatorStore.ownedConversations(CAKE_CHAT_SESSION_ID),
  ).toContainEqual(expect.objectContaining({ title: "Background title changed", running: true }));
  expect(observe).not.toHaveBeenCalled();
  expect(fixture.models.discussionConversations).toHaveLength(0);
});

it("opens only the requested sidecar, releases on close and reenters with one fresh subscription and preserved drafts", async () => {
  using test = await setup();
  const { fixture, chat, observe, ended } = test;
  const record = thread(CAKE_CHAT_SESSION_ID, 3);
  act(() => {
    expect(chat.openSideChat(record.id)).toBe(true);
  });
  const model = fixture.models.findDiscussionConversation(record.sidecarSessionId!)!;
  await vi.waitFor(() => expect(model.observedSnapshotRevision).toBe(1));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledWith({
    parentSessionId: CAKE_CHAT_SESSION_ID,
    threadId: record.id,
    workingDirectory: "/project",
  });
  const store = chat.sideChats.chatStore(record.id)!;
  store.setDraft("Unsent user draft");
  act(() => {
    chat.conversationSessionStore.sideChatStore.close();
  });
  await vi.waitFor(() => expect(ended).toEqual([record.id]));
  expect(model.parts).toHaveLength(0);
  act(() => {
    chat.openSideChat(record.id);
  });
  await vi.waitFor(() => expect(model.observedSnapshotRevision).toBe(1));
  expect(observe).toHaveBeenCalledTimes(2);
  expect(fixture.models.discussionConversations).toEqual([model]);
  expect(chat.sideChats.chatStore(record.id)).toBe(store);
  expect(store.draft).toBe("Unsent user draft");
});

it("shares scoped nonvisual demand and lets an embedded transcript own observation independently of its parent", async () => {
  using test = await setup();
  const { fixture, observe, ended } = test;
  const record = thread("project-parent", 4);
  const session = fixture.root.reviewsStore.discussionSession(record.id)!;
  const first = session.retainTranscript();
  const second = session.retainTranscript();
  await vi.waitFor(() => expect(session.model.observedSnapshotRevision).toBe(1));
  fixture.root.sessionRegistry.observationRetention.remove("project-parent");
  expect(observe).toHaveBeenCalledTimes(1);
  first();
  first();
  expect(ended).toEqual([]);
  second();
  await vi.waitFor(() => expect(ended).toEqual([record.id]));
  const view = render(
    <StoreProvider store={fixture.root}>
      <ChatTranscript store={session.chatStore} />
    </StoreProvider>,
  );
  await screen.findByText(`Transcript ${record.sidecarSessionId}`);
  expect(observe).toHaveBeenCalledTimes(2);
  view.unmount();
  await vi.waitFor(() => expect(ended).toHaveLength(2));
  expect(session.model.parts).toHaveLength(0);
});

it("an explicit Project Session opening owns demand while waiting for its first sidecar snapshot", async () => {
  using test = await setup();
  const record = thread("project-parent", 6);
  test.parent.openSideChat(record.id);
  await vi.waitFor(() =>
    expect(
      test.parent.conversationSessionStore.sideChatStore.target?.navigationTarget,
    ).toMatchObject({ sessionId: record.sidecarSessionId }),
  );
  expect(test.observe).toHaveBeenCalledTimes(1);
  expect(test.fixture.models.discussionConversations).toHaveLength(1);
  test.parent.conversationSessionStore.sideChatStore.close();
  await vi.waitFor(() => expect(test.ended).toEqual([record.id]));
});

it("a hidden sidecar's interview request is real nonvisual demand, not a reason to hydrate its siblings", async () => {
  using test = await setup();
  const record = thread(CAKE_CHAT_SESSION_ID, 9);
  const stopEvents = observeApplicationEvents(test.runtime, test.fixture.root);
  try {
    expect(test.chat.sideChats.discussionSessions).toHaveLength(0);
    await Effect.runPromise(
      Queue.offer(test.events, {
        type: "interview-requested",
        requestId: "operation",
        interviewRequestId: "request",
        record: {
          id: "interview",
          sessionId: record.sidecarSessionId!,
          request: {
            protocol: "cake.request/v1",
            id: "scope",
            title: "Choose scope",
            responseSchema: { type: "object" },
            view: { type: "form", fields: [] },
            fallback: { markdown: "Choose scope" },
          },
        },
      }),
    );
    await vi.waitFor(() => expect(test.observe).toHaveBeenCalledTimes(1));
    const session = test.chat.sideChats.discussionSession(record.id)!;
    expect(session.conversationSessionStore.interviewStore.waiting).toBe(true);
    expect(test.fixture.models.discussionConversations).toEqual([session.model]);
    session.conversationSessionStore.interviewStore.clearPending();
    await vi.waitFor(() => expect(test.ended).toEqual([record.id]));
  } finally {
    stopEvents();
  }
});

it("a source link selects the original entry after a cold sidecar snapshot arrives", async () => {
  using test = await setup();
  const record = thread(CAKE_CHAT_SESSION_ID, 11);
  test.chat.openSideChat(record.id, "source-entry");
  const chat = test.chat.sideChats.chatStore(record.id)!;
  await vi.waitFor(() =>
    expect(chat.transcriptInteraction.selectedMessageId).toBe(record.sidecarSessionId),
  );
  expect(test.observe).toHaveBeenCalledTimes(1);
});

it("a nonvisual command owns first-snapshot demand only until its preparation finishes", async () => {
  using test = await setup();
  const record = thread("project-parent", 10);
  const session = test.fixture.root.reviewsStore.discussionSession(record.id)!;
  expect(await session.conversationSessionStore.prepareForCommand()).toBe(true);
  expect(test.observe).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(test.ended).toEqual([record.id]));
});
