import { Effect, Queue, Stream } from "effect";
import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { DiscussionCatalogUpdate } from "../../../../src/domain/application/catalog-data";
import type { DiscussionSessionUpdate } from "../../../../src/domain/discussion-sessions/discussion-session-data";
import {
  SessionChatError,
  type ConversationUpdate,
} from "../../../../src/domain/conversations/conversation-data";
import type { CakeChatControlUpdate } from "../../../../src/domain/cake-chats/cake-chat-data";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { CakeIpcClient } from "../../../../src/ipc/client/CakeIpcClient";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { createModelObserver, observeStream } from "../../../../src/renderer/observers";
import type { Runtime } from "../../../../src/renderer/runtime";
import { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";

function runtimeFor(client: CakeIpcClientService): Runtime {
  const execute: Runtime["execute"] = (effect, signal) =>
    Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, client),
      signal ? { signal } : undefined,
    );
  return {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: async () => undefined,
  };
}

const conversationSnapshot = (sessionId: string, output = "history") =>
  ({
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      parts: [
        {
          id: "historical-tool",
          kind: "tool",
          name: "read",
          input: "README.md",
          output,
          state: "success",
        },
      ],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: [],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  }) satisfies ConversationUpdate;

const discussionSnapshot = (sessionId: string, output: string): DiscussionSessionUpdate => ({
  _tag: "Snapshot",
  revision: 1,
  snapshot: {
    identity: {
      _tag: "DiscussionSession",
      sessionId,
      parentSessionId: "project-1",
    },
    conversation: conversationSnapshot(sessionId, output).snapshot,
  },
});

function baseInput(projection: RootProjection, sessionId = "project-1") {
  return {
    projects: projection.projects,
    sessionCatalog: projection.sessionCatalog,
    cakeChatCatalog: projection.cakeChatCatalog,
    projectSessions: [
      {
        target: { sessionId, workingDirectory: "/project" },
        conversation: projection.projectConversation(sessionId, "/project"),
        discussions: projection.discussionCatalog(sessionId),
        subagents: projection.subagentCatalog(sessionId),
        schedules: projection.scheduledMessageCatalog(sessionId),
      },
    ],
    cakeChats: [],
  };
}

function baseClient(overrides: object = {}) {
  return {
    projects: { observeCatalog: () => Stream.never },
    cakeChats: { observeCatalog: () => Stream.never },
    conversations: { observe: () => Stream.never },
    discussionSessions: { observeCatalog: () => Stream.never, observe: () => Stream.never },
    subagents: { observe: () => Stream.never },
    scheduledMessages: { observe: () => Stream.never },
    ...overrides,
  } as unknown as CakeIpcClientService;
}

describe("Project Session composition observer", () => {
  it("starts the Conversation from the known target without waiting for aggregate side authorities", async () => {
    const updates = await Effect.runPromise(Queue.unbounded<ConversationUpdate>());
    const observes = vi.fn(() => Stream.fromQueue(updates));
    const client = baseClient({ conversations: { observe: observes } });
    const projection = RootProjection.create();
    const observer = createModelObserver(runtimeFor(client));

    try {
      observer.sync(baseInput(projection));
      await vi.waitFor(() => expect(observes).toHaveBeenCalledOnce());
      await Effect.runPromise(Queue.offer(updates, conversationSnapshot("project-1")));
      await vi.waitFor(() =>
        expect(projection.projectConversation("project-1", "/project").sessionFile).not.toBe(""),
      );
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
    }
  });

  it("quietly stops only an unavailable Project Session Conversation observation", async () => {
    vi.useFakeTimers();
    const stopped = vi.fn();
    const projection = RootProjection.create();
    const observes = vi.fn(() =>
      Stream.fail(
        new SessionChatError({
          operation: "observeProjectSession",
          message: "That session is no longer available",
        }),
      ),
    );
    const observer = createModelObserver(
      runtimeFor(baseClient({ conversations: { observe: observes } })),
      stopped,
    );

    try {
      observer.sync(baseInput(projection));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observes).toHaveBeenCalledOnce();
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
      vi.useRealTimers();
    }
  });

  it("cancels a stale Conversation observation when demand changes", async () => {
    const stale = await Effect.runPromise(Queue.unbounded<ConversationUpdate>());
    const current = await Effect.runPromise(Queue.unbounded<ConversationUpdate>());
    const client = baseClient({
      conversations: {
        observe: ({ sessionId }: { sessionId: string }) =>
          Stream.fromQueue(sessionId === "stale" ? stale : current),
      },
    });
    const projection = RootProjection.create();
    const observer = createModelObserver(runtimeFor(client));

    try {
      observer.sync(baseInput(projection, "stale"));
      observer.sync(baseInput(projection, "current"));
      await Effect.runPromise(Queue.offer(stale, conversationSnapshot("stale")));
      await Effect.runPromise(Queue.offer(current, conversationSnapshot("current")));
      await vi.waitFor(() =>
        expect(projection.projectConversation("current", "/project").sessionFile).not.toBe(""),
      );
      expect(projection.projectConversation("stale", "/project").sessionFile).toBe("");
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
    }
  });
});

describe("focused projection lifetimes", () => {
  it("unloads an idle retained identity and re-observes it into a fresh transcript projection", async () => {
    const loadedIds: string[] = observable(["project-1"]);
    const observedIds: string[] = observable(["project-1"]);
    const observations: Queue.Queue<ConversationUpdate>[] = [];
    const projection = RootProjection.create();
    const client = baseClient({
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      conversations: {
        observe: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<ConversationUpdate>();
              observations.push(queue);
              return Stream.fromQueue(queue);
            }),
          ),
      },
    });
    const observer = createModelObserver(runtimeFor(client));
    observer.observe({
      projection,
      projectSessionCatalogQueries: () => [],
      loadedProjectSessions: () =>
        loadedIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
      projectSessionTargets: () =>
        observedIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
      cakeChatTargets: () => [],
    });

    try {
      await vi.waitFor(() => expect(observations).toHaveLength(1));
      await Effect.runPromise(
        Queue.offer(observations[0]!, conversationSnapshot("project-1", "old")),
      );
      await vi.waitFor(() =>
        expect(projection.projectConversations[0]?.parts[0]?.value).toEqual(
          expect.objectContaining({ output: "old" }),
        ),
      );

      observedIds.splice(0, 1);
      await vi.waitFor(() => expect(projection.projectConversations[0]?.parts).toEqual([]));
      expect(loadedIds).toEqual(["project-1"]);

      observedIds.push("project-1");
      await vi.waitFor(() => expect(observations).toHaveLength(2));
      expect(projection.projectConversations[0]?.parts).toEqual([]);
      await Effect.runPromise(
        Queue.offer(observations[1]!, conversationSnapshot("project-1", "new")),
      );
      await vi.waitFor(() =>
        expect(projection.projectConversations[0]?.parts[0]?.value).toEqual(
          expect.objectContaining({ output: "new" }),
        ),
      );
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
    }
  });
});

describe("Discussion sidecar retention", () => {
  it("unloads sidecar payload with parent observation demand and rehydrates without a reactive cycle", async () => {
    const parentId = "project-1";
    const sidecarId = "sidecar-1";
    const loadedIds: string[] = observable([parentId]);
    const observedIds: string[] = observable([parentId]);
    const catalogUpdates = await Effect.runPromise(Queue.unbounded<DiscussionCatalogUpdate>());
    const sidecarObservations: Queue.Queue<DiscussionSessionUpdate>[] = [];
    const projection = RootProjection.create();
    const catalog = projection.discussionCatalog(parentId);
    const retainedSessions: Array<{ props: { discussionCatalog: typeof catalog } }> = observable([
      { props: { discussionCatalog: catalog } },
    ]);
    const registry = {
      sessions: retainedSessions,
      observationRetention: { sessions: retainedSessions },
    } as unknown as SessionRegistryStore;
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const reviews = mount(
      createStore(ReviewsStore, {
        sessionRegistry: registry,
        discussionSessionModel: (sessionId, workingDirectory) =>
          projection.discussionConversation(sessionId, workingDirectory),
        operations,
        modelPresets: () => [],
        openModelPresetSettings: () => undefined,
      }),
    );
    const client = baseClient({
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      discussionSessions: {
        observeCatalog: () => Stream.fromQueue(catalogUpdates),
        observe: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<DiscussionSessionUpdate>();
              sidecarObservations.push(queue);
              return Stream.fromQueue(queue);
            }),
          ),
      },
    });
    const observer = createModelObserver(runtimeFor(client));
    observer.observe({
      projection,
      projectSessionCatalogQueries: () => [],
      loadedProjectSessions: () =>
        loadedIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
      projectSessionTargets: () =>
        observedIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
      cakeChatTargets: () => [],
    });

    try {
      await Effect.runPromise(
        Queue.offer(catalogUpdates, {
          _tag: "Snapshot",
          revision: 1,
          parentSessionId: parentId,
          threads: [
            {
              id: "thread-1",
              parentSessionId: parentId,
              workingDirectory: "/project",
              sidecarSessionId: sidecarId,
              anchor: {
                path: `session:${parentId}`,
                view: "session",
                start: { diffLine: 0 },
                end: { diffLine: 0 },
                selectedText: "",
                contextBefore: "",
                contextAfter: "",
                diff: "",
              },
              parts: [],
              status: "open",
              createdAt: "now",
              updatedAt: "now",
            },
          ],
        }),
      );
      await vi.waitFor(() => expect(sidecarObservations).toHaveLength(1));
      await Effect.runPromise(
        Queue.offer(sidecarObservations[0]!, discussionSnapshot(sidecarId, "old sidecar")),
      );
      await vi.waitFor(() => expect(reviews.discussionSessions).toHaveLength(1));
      await vi.waitFor(() =>
        expect(projection.findDiscussionConversation(sidecarId)?.parts).toHaveLength(1),
      );
      const sidecarModel = projection.findDiscussionConversation(sidecarId);

      // The parent identity remains loaded, but both Stores and observer leave retention together.
      retainedSessions.splice(0, 1);
      observedIds.splice(0, 1);
      await vi.waitFor(() => expect(reviews.discussionSessions).toHaveLength(0));
      await vi.waitFor(() => expect(sidecarModel?.parts).toEqual([]));
      expect(projection.findDiscussionConversation(sidecarId)).toBe(sidecarModel);
      expect(projection.discussionCatalog(parentId).threads).toHaveLength(1);

      retainedSessions.push({ props: { discussionCatalog: catalog } });
      observedIds.push(parentId);
      await vi.waitFor(() => expect(sidecarObservations).toHaveLength(2));
      expect(reviews.discussionSessions).toHaveLength(1);
      expect(projection.findDiscussionConversation(sidecarId)).toBe(sidecarModel);
      expect(sidecarModel?.parts).toEqual([]);
      await Effect.runPromise(
        Queue.offer(sidecarObservations[1]!, discussionSnapshot(sidecarId, "fresh sidecar")),
      );
      await vi.waitFor(() =>
        expect(projection.findDiscussionConversation(sidecarId)?.parts[0]?.value).toEqual(
          expect.objectContaining({ output: "fresh sidecar" }),
        ),
      );

      // A true unload first removes Store/observation demand, then releases the
      // parent's focused Models, including sidecar identity.
      retainedSessions.splice(0, 1);
      observedIds.splice(0, 1);
      await vi.waitFor(() => expect(reviews.discussionSessions).toHaveLength(0));
      loadedIds.splice(0, 1);
      await vi.waitFor(() =>
        expect(projection.findDiscussionConversation(sidecarId)).toBeUndefined(),
      );
      expect(projection.discussionCatalogs).toHaveLength(0);

      loadedIds.push(parentId);
      observedIds.push(parentId);
      await vi.waitFor(() => expect(projection.discussionCatalogs).toHaveLength(1));
      const reloadedCatalog = projection.discussionCatalog(parentId);
      expect(reloadedCatalog).not.toBe(catalog);
      retainedSessions.push({ props: { discussionCatalog: reloadedCatalog } });
      await Effect.runPromise(
        Queue.offer(catalogUpdates, {
          _tag: "Snapshot",
          revision: 1,
          parentSessionId: parentId,
          threads: [
            {
              id: "thread-1",
              parentSessionId: parentId,
              workingDirectory: "/project",
              sidecarSessionId: sidecarId,
              anchor: {
                path: `session:${parentId}`,
                view: "session",
                start: { diffLine: 0 },
                end: { diffLine: 0 },
                selectedText: "",
                contextBefore: "",
                contextAfter: "",
                diff: "",
              },
              parts: [],
              status: "open",
              createdAt: "now",
              updatedAt: "later",
            },
          ],
        }),
      );
      await vi.waitFor(() => expect(sidecarObservations).toHaveLength(3));
      const reloadedSidecar = projection.findDiscussionConversation(sidecarId);
      expect(reloadedSidecar).not.toBe(sidecarModel);
      expect(reloadedSidecar?.parts).toEqual([]);
    } finally {
      observer.stop();
      reviews[Symbol.dispose]();
      operations[Symbol.dispose]();
      projection[Symbol.dispose]();
    }
  });
});

describe("Cake Chat composition observer", () => {
  it("clears stopped controls and replays only current pending requests on re-entry", async () => {
    const controls = await Effect.runPromise(Queue.unbounded<CakeChatControlUpdate>());
    let currentRequests: CakeChatControlUpdate["requests"] = [];
    const client = baseClient({
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeControls: () =>
          Stream.make({ _tag: "Snapshot" as const, requests: currentRequests }).pipe(
            Stream.concat(Stream.fromQueue(controls)),
          ),
      },
    });
    const projection = RootProjection.create();
    const observer = createModelObserver(runtimeFor(client));
    const controlModel = projection.controlsForCakeChat("cake-chat-1");
    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [
        {
          target: { sessionId: "cake-chat-1", tools: [] },
          conversation: projection.cakeChatConversation("cake-chat-1"),
          controls: controlModel,
        },
      ],
    });

    const request = {
      _tag: "ControlRequested" as const,
      sessionId: "cake-chat-1",
      controlRequestId: crypto.randomUUID(),
      invocation: { name: "app.showSettings", arguments: {} },
    };
    currentRequests = [request];
    await Effect.runPromise(Queue.offer(controls, { _tag: "Snapshot", requests: currentRequests }));
    await vi.waitFor(() => expect(controlModel.requests).toEqual([request]));

    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [],
    });
    expect(controlModel.requests).toEqual([]);

    // The stopped stream misses settlement; its next current-first snapshot repairs state.
    currentRequests = [];
    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [
        {
          target: { sessionId: "cake-chat-1", tools: [] },
          conversation: projection.cakeChatConversation("cake-chat-1"),
          controls: controlModel,
        },
      ],
    });
    await vi.waitFor(() => expect(controlModel.requests).toEqual([]));

    const stillPending = { ...request, controlRequestId: crypto.randomUUID() };
    currentRequests = [stillPending];
    await Effect.runPromise(Queue.offer(controls, { _tag: "Snapshot", requests: currentRequests }));
    await vi.waitFor(() => expect(controlModel.requests).toEqual([stillPending]));
    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [],
    });
    expect(controlModel.requests).toEqual([]);
    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [
        {
          target: { sessionId: "cake-chat-1", tools: [] },
          conversation: projection.cakeChatConversation("cake-chat-1"),
          controls: controlModel,
        },
      ],
    });
    await vi.waitFor(() => expect(controlModel.requests).toEqual([stillPending]));
    expect(controlModel.requests).toHaveLength(1);

    observer.stop();
    projection[Symbol.dispose]();
  });
});
