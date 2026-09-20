import { Effect, Queue, Stream } from "effect";
import { observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { CakeIpcClient } from "../../../../src/ipc/client/CakeIpcClient";
import type { ProjectSessionProjection } from "../../../../src/domain/project-sessions/project-session-data";
import {
  SessionChatError,
  type ConversationUpdate,
} from "../../../../src/domain/conversations/conversation-data";
import type { DiscussionCatalogUpdate } from "../../../../src/domain/application/catalog-data";
import type { SubagentUpdate } from "../../../../src/domain/subagents/subagent-data";
import type { CakeChatControlUpdate } from "../../../../src/domain/cake-chats/cake-chat-data";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { createModelObserver, observeStream } from "../../../../src/renderer/observers";
import type { Runtime } from "../../../../src/renderer/runtime";

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

const aggregate = (sessionId = "project-1"): ProjectSessionProjection => ({
  identity: {
    _tag: "ProjectSession",
    sessionId,
    projectPath: "/project",
    workingDirectory: "/project",
  },
  project: { path: "/project", name: "Project" },
  workingDirectory: { path: "/project" },
  lifecycle: { resolved: false, unread: false },
  primaryConversation: { sessionId },
  discussionSessions: [],
  subagentSessions: [],
  reviewThreads: [],
  artifactLinks: [],
});

const conversationSnapshot = (sessionId: string): ConversationUpdate => ({
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
        output: "history",
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
});

const emptyDiscussions = (sessionId: string): DiscussionCatalogUpdate => ({
  _tag: "Snapshot",
  revision: 1,
  parentSessionId: sessionId,
  threads: [],
});

const emptySubagents = (sessionId: string): SubagentUpdate => ({
  _tag: "Snapshot",
  revision: 1,
  parentSessionId: sessionId,
  activities: [],
  backgroundActive: false,
});

const neverAfter = <A>(value: A) => Stream.make(value).pipe(Stream.concat(Stream.never));

function baseInput(projection: RootProjection, sessionId = "project-1") {
  return {
    projects: projection.projects,
    sessionCatalog: projection.sessionCatalog,
    cakeChatCatalog: projection.cakeChatCatalog,
    projectSessions: [
      {
        target: { sessionId, workingDirectory: "/project" },
        aggregate: projection.projectSession(sessionId),
        conversation: projection.projectConversation(sessionId, "/project"),
        discussions: projection.discussionCatalog(sessionId),
        subagents: projection.subagentCatalog(sessionId),
        schedules: projection.scheduledMessageCatalog(sessionId),
        catalogKey: "active",
      },
    ],
    cakeChats: [],
  };
}

describe("Project Session composition observer", () => {
  it("holds a successful aggregate read until one relationship invalidation", async () => {
    vi.useFakeTimers();
    const projection = RootProjection.create();
    const reads = vi.fn(() => Effect.succeed(aggregate()));
    const client = {
      projects: { observeCatalog: () => Stream.never },
      cakeChats: { observeCatalog: () => Stream.never },
      projectSessions: { readProjection: reads },
      conversations: { observe: () => Stream.never },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const observer = createModelObserver(runtimeFor(client));
    const input = baseInput(projection);

    try {
      observer.sync(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(reads).toHaveBeenCalledOnce();

      input.projectSessions[0]!.discussions.relationshipRevision += 1;
      observer.sync(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
      vi.useRealTimers();
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
    const client = {
      projects: { observeCatalog: () => Stream.never },
      cakeChats: { observeCatalog: () => Stream.never },
      projectSessions: { readProjection: () => Effect.succeed(aggregate()) },
      conversations: { observe: observes },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const observer = createModelObserver(runtimeFor(client), stopped);
    const input = baseInput(projection);

    try {
      observer.sync(input);
      await vi.advanceTimersByTimeAsync(0);
      observer.sync(input);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(observes).toHaveBeenCalledOnce();
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
      vi.useRealTimers();
    }
  });

  it("reads the aggregate before independently observing Conversation and focused authorities", async () => {
    const conversationUpdates = await Effect.runPromise(Queue.unbounded<ConversationUpdate>());
    const discussionUpdates = await Effect.runPromise(Queue.unbounded<DiscussionCatalogUpdate>());
    let resolved = false;
    const reads = vi.fn(() =>
      Effect.succeed({ ...aggregate(), lifecycle: { resolved, unread: false } }),
    );
    const client = {
      projects: { observeCatalog: () => Stream.never },
      cakeChats: { observeCatalog: () => Stream.never },
      projectSessions: { readProjection: reads },
      conversations: { observe: () => Stream.fromQueue(conversationUpdates) },
      discussionSessions: { observeCatalog: () => Stream.fromQueue(discussionUpdates) },
      subagents: { observe: () => neverAfter(emptySubagents("project-1")) },
      scheduledMessages: {
        observe: () => neverAfter({ _tag: "Snapshot", revision: 1, messages: [] }),
      },
    } as unknown as CakeIpcClientService;
    const projection = RootProjection.create();
    const observer = createModelObserver(runtimeFor(client));
    const input = baseInput(projection);

    observer.sync(input);
    await vi.waitFor(() => expect(projection.projectSession("project-1").loadedRevision).toBe(1));
    expect(reads).toHaveBeenCalledOnce();
    expect(projection.projectConversation("project-1", "/project").sessionFile).toBe("");

    // The aggregate's primaryConversation reference unlocks the independent stream.
    observer.sync(input);
    await Effect.runPromise(Queue.offer(conversationUpdates, conversationSnapshot("project-1")));
    await Effect.runPromise(Queue.offer(discussionUpdates, emptyDiscussions("project-1")));
    await vi.waitFor(() =>
      expect(projection.projectConversation("project-1", "/project").sessionFile).not.toBe(""),
    );
    const transcript = projection.projectConversation("project-1", "/project").parts;
    expect(transcript[0]?.value).toEqual(expect.objectContaining({ output: "history" }));
    expect(projection.subagentCatalog("project-1").backgroundActive).toBe(false);
    expect(projection.discussionCatalog("project-1").threads).toEqual([]);

    await Effect.runPromise(
      Queue.offer(conversationUpdates, {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "StreamingChanged",
          sessionId: "project-1",
          streaming: true,
        },
      }),
    );
    await vi.waitFor(() =>
      expect(projection.projectConversation("project-1", "/project").streaming).toBe(true),
    );
    expect(reads).toHaveBeenCalledOnce();

    resolved = true;
    input.projectSessions[0]!.catalogKey = "resolved";
    observer.sync(input);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    expect(projection.projectSession("project-1").resolved).toBe(true);
    expect(projection.projectConversation("project-1", "/project").parts).toBe(transcript);

    // Relationship authority changes invalidate only the aggregate read. The transcript stays put.
    await Effect.runPromise(
      Queue.offer(discussionUpdates, {
        _tag: "Event",
        revision: 2,
        parentSessionId: "project-1",
        event: { _tag: "Replaced", threads: [] },
      }),
    );
    await vi.waitFor(() =>
      expect(projection.discussionCatalog("project-1").relationshipRevision).toBe(2),
    );
    observer.sync(input);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(3));
    expect(projection.projectConversation("project-1", "/project").parts).toBe(transcript);

    observer.stop();
    projection[Symbol.dispose]();
  });

  it("cancels a stale Conversation observation when demand changes", async () => {
    const stale = await Effect.runPromise(Queue.unbounded<ConversationUpdate>());
    const current = await Effect.runPromise(Queue.unbounded<ConversationUpdate>());
    const client = {
      projects: { observeCatalog: () => Stream.never },
      cakeChats: { observeCatalog: () => Stream.never },
      projectSessions: {
        readProjection: ({ sessionId }: { sessionId: string }) =>
          Effect.succeed(aggregate(sessionId)),
      },
      conversations: {
        observe: ({ sessionId }: { sessionId: string }) =>
          Stream.fromQueue(sessionId === "stale" ? stale : current),
      },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const projection = RootProjection.create();
    const observer = createModelObserver(runtimeFor(client));

    const staleInput = baseInput(projection, "stale");
    observer.sync(staleInput);
    await vi.waitFor(() => expect(projection.projectSession("stale").loadedRevision).toBe(1));
    observer.sync(staleInput);
    const currentInput = baseInput(projection, "current");
    observer.sync(currentInput);
    await vi.waitFor(() => expect(projection.projectSession("current").loadedRevision).toBe(1));
    observer.sync(currentInput);

    await Effect.runPromise(Queue.offer(stale, conversationSnapshot("stale")));
    await Effect.runPromise(Queue.offer(current, conversationSnapshot("current")));
    await vi.waitFor(() =>
      expect(projection.projectConversation("current", "/project").sessionFile).not.toBe(""),
    );
    expect(projection.projectConversation("stale", "/project").sessionFile).toBe("");

    observer.stop();
    projection[Symbol.dispose]();
  });
});

describe("focused projection lifetimes", () => {
  it("releases unloaded Models, retains staged Discussions, and reloads clean projections", async () => {
    const loadedProjectIds: string[] = observable(["project-1"]);
    const stagedProjectIds: string[] = observable([]);
    const loadedCakeChatIds: string[] = observable(["cake-chat-1"]);
    const projection = RootProjection.create();
    const client = {
      projects: { observeCatalog: () => Stream.never },
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeControls: () => Stream.never,
      },
      projectSessions: { readProjection: () => Effect.succeed(aggregate()) },
      conversations: { observe: () => Stream.never },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const observer = createModelObserver(runtimeFor(client));
    observer.observe({
      projection,
      projectSessionCatalogQueries: () => [],
      loadedProjectSessions: () =>
        loadedProjectIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
      loadedCakeChatIds: () => loadedCakeChatIds,
      projectSessionTargets: () =>
        loadedProjectIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
      stagedProjectSessionTargets: () =>
        stagedProjectIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
      cakeChatTargets: () => loadedCakeChatIds.map((sessionId) => ({ sessionId, tools: [] })),
    });

    try {
      await vi.waitFor(() => expect(projection.projectSessions).toHaveLength(1));
      const oldAggregate = projection.projectSessions[0]!;
      const oldConversation = projection.projectConversations[0]!;
      const oldDiscussions = projection.discussionCatalogs[0]!;
      const oldSubagents = projection.subagentCatalogs[0]!;
      const oldSchedules = projection.scheduledMessageCatalogs[0]!;
      const oldCakeConversation = projection.cakeChatConversations[0]!;
      const oldControls = projection.cakeChatControls[0]!;
      oldAggregate.discussionSessions = [
        {
          threadId: "thread-1",
          sessionId: "discussion-1",
          status: "open",
          anchor: "session",
        },
      ];
      oldDiscussions.relationshipRevision = 7;
      oldSubagents.backgroundActive = true;
      oldControls.requests.push({
        _tag: "ControlRequested",
        sessionId: "cake-chat-1",
        controlRequestId: crypto.randomUUID(),
        invocation: { name: "app.showSettings", arguments: {} },
      });

      stagedProjectIds.push("project-1");
      loadedProjectIds.splice(0, 1);
      loadedCakeChatIds.splice(0, 1);
      await vi.waitFor(() => {
        expect(projection.projectSessions).toHaveLength(0);
        expect(projection.projectConversations).toHaveLength(0);
        expect(projection.subagentCatalogs).toHaveLength(0);
        expect(projection.scheduledMessageCatalogs).toHaveLength(0);
        expect(projection.cakeChatConversations).toHaveLength(0);
        expect(projection.cakeChatControls).toHaveLength(0);
      });
      expect(projection.discussionCatalogs).toEqual([oldDiscussions]);

      stagedProjectIds.splice(0, 1);
      await vi.waitFor(() => expect(projection.discussionCatalogs).toHaveLength(0));

      loadedProjectIds.push("project-1");
      loadedCakeChatIds.push("cake-chat-1");
      await vi.waitFor(() => {
        expect(projection.projectSessions).toHaveLength(1);
        expect(projection.cakeChatControls).toHaveLength(1);
      });

      expect(projection.projectSessions[0]).not.toBe(oldAggregate);
      expect(projection.projectConversations[0]).not.toBe(oldConversation);
      expect(projection.discussionCatalogs[0]).not.toBe(oldDiscussions);
      expect(projection.subagentCatalogs[0]).not.toBe(oldSubagents);
      expect(projection.scheduledMessageCatalogs[0]).not.toBe(oldSchedules);
      expect(projection.cakeChatConversations[0]).not.toBe(oldCakeConversation);
      expect(projection.cakeChatControls[0]).not.toBe(oldControls);
      expect(projection.projectSessions[0]!.discussionSessions).toEqual([]);
      expect(projection.discussionCatalogs[0]!.relationshipRevision).toBe(0);
      expect(projection.subagentCatalogs[0]!.backgroundActive).toBe(false);
      expect(projection.cakeChatControls[0]!.requests).toEqual([]);
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
    }
  });
});

describe("Cake Chat composition observer", () => {
  it("composes Conversation and Cake controls without Project Session fields", async () => {
    const updates = await Effect.runPromise(Queue.unbounded<ConversationUpdate>());
    const controls = await Effect.runPromise(Queue.unbounded<CakeChatControlUpdate>());
    const client = {
      projects: { observeCatalog: () => Stream.never },
      conversations: { observe: () => Stream.fromQueue(updates) },
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeControls: () => Stream.fromQueue(controls),
      },
    } as unknown as CakeIpcClientService;
    const projection = RootProjection.create();
    const observer = createModelObserver(runtimeFor(client));
    const conversation = projection.cakeChatConversation("cake-chat-1");
    const controlModel = projection.controlsForCakeChat("cake-chat-1");
    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [
        {
          target: { sessionId: "cake-chat-1", tools: [] },
          conversation,
          controls: controlModel,
        },
      ],
    });

    await Effect.runPromise(Queue.offer(updates, conversationSnapshot("cake-chat-1")));
    await Effect.runPromise(
      Queue.offer(controls, {
        _tag: "Requested",
        request: {
          _tag: "ControlRequested",
          sessionId: "cake-chat-1",
          controlRequestId: crypto.randomUUID(),
          invocation: { name: "app.showSettings", arguments: {} },
        },
      }),
    );

    await vi.waitFor(() => expect(controlModel.requests).toHaveLength(1));
    expect(conversation.sessionFile).toContain("cake-chat-1");
    expect(conversation).not.toHaveProperty("controlRequests");
    expect(conversation).not.toHaveProperty("projectPath");
    expect(controlModel).not.toHaveProperty("workingDirectory");

    observer.stop();
    projection[Symbol.dispose]();
  });
});
