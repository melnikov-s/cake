import { Effect, Queue, Stream } from "effect";
import { batch, createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type {
  DiscussionCatalogUpdate,
  SessionCatalogUpdate,
} from "../../../../src/domain/application/catalog-data";
import type { DiscussionSessionUpdate } from "../../../../src/domain/discussion-sessions/discussion-session-data";
import {
  SessionChatError,
  type ConversationUpdate,
} from "../../../../src/domain/conversations/conversation-data";
import type { CakeChatControlUpdate } from "../../../../src/domain/cake-chats/cake-chat-data";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { CakeIpcClient } from "../../../../src/ipc/client/CakeIpcClient";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import {
  createModelObserver,
  observeModels,
  observeStream,
} from "../../../../src/renderer/observers";
import { mountRootStore } from "../../../../src/renderer/bootstrap/mount-root-store";
import type { Client } from "../../../../src/renderer/client/Client";
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

function recordingRuntime(client: CakeIpcClientService) {
  const realRuntime = runtimeFor(client);
  const applied = Effect.runSync(Queue.unbounded<void>());
  const cancellations: Array<ReturnType<typeof vi.fn>> = [];
  const observe: Runtime["observe"] = (source, consume, options) => {
    const cancel = vi.fn(
      realRuntime.observe(
        source,
        (update) => {
          consume(update);
          Effect.runSync(Queue.offer(applied, undefined));
        },
        options,
      ),
    );
    cancellations.push(cancel);
    return cancel;
  };
  return { runtime: { ...realRuntime, observe }, cancellations, applied };
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
  it("delivers a title event to the pending projection before a file-backed catalog entry exists", async () => {
    const updates = await Effect.runPromise(Queue.unbounded<SessionCatalogUpdate>());
    const changed = vi.fn();
    const projection = RootProjection.create();
    const client = baseClient({
      projectSessions: { observeCatalog: () => Stream.fromQueue(updates) },
    });
    const observer = createModelObserver(runtimeFor(client));
    try {
      observer.sync({
        ...baseInput(projection),
        projectSessions: [],
        projectSessionCatalogQueries: [{ projectPath: "/project", resolved: false }],
        onProjectSessionTitleChanged: changed,
      });
      await Effect.runPromise(
        Queue.offer(updates, { _tag: "Snapshot", revision: 1, sessions: [] }),
      );
      await Effect.runPromise(
        Queue.offer(updates, {
          _tag: "Event",
          revision: 2,
          event: { _tag: "TitleChanged", sessionId: "new-session", title: "Generated title" },
        }),
      );
      await vi.waitFor(() =>
        expect(changed).toHaveBeenCalledWith("new-session", "Generated title"),
      );
      expect(projection.sessionCatalog.sessions).toHaveLength(0);
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
    }
  });
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
  it("reconciles in-place registry changes and preserves staged Discussion catalogs until staging ends", () => {
    const loaded = observable([{ sessionId: "loaded", workingDirectory: "/project" }]);
    const staged = observable([{ sessionId: "staged", workingDirectory: "/project" }]);
    const cakeChatIds = observable(["cake-one"]);
    const projection = RootProjection.create();
    const observer = createModelObserver(
      runtimeFor(
        baseClient({
          managedWorktrees: {
            observeCatalog: () => Stream.never,
            observeOperations: () => Stream.never,
          },
        }),
      ),
    );
    observer.observe({
      projection,
      projectSessionCatalogQueries: () => [],
      loadedProjectSessions: () => loaded,
      loadedCakeChatIds: () => cakeChatIds,
      stagedProjectSessionTargets: () => staged,
      projectSessionTargets: () => [],
      cakeChatTargets: () => [],
    });
    try {
      expect(projection.findProjectConversation("loaded")).toBeDefined();
      expect(projection.cakeChatConversations.map((model) => model.sessionId)).toEqual([
        "cake-one",
      ]);
      const stagedCatalog = projection.discussionCatalog("staged");
      loaded.push({ sessionId: "staged", workingDirectory: "/project" });
      expect(projection.findProjectConversation("staged")).toBeDefined();
      loaded.splice(1, 1);
      expect(projection.findProjectConversation("staged")).toBeUndefined();
      expect(projection.discussionCatalogs).toContain(stagedCatalog);
      staged.splice(0, 1);
      expect(projection.discussionCatalogs).not.toContain(stagedCatalog);

      const controls = projection.controlsForCakeChat("cake-one");
      cakeChatIds.splice(0, 1, "cake-two");
      expect(projection.cakeChatConversations.map((model) => model.sessionId)).toEqual([
        "cake-two",
      ]);
      expect(projection.cakeChatControls).not.toContain(controls);
      loaded.splice(0, 1, { sessionId: "new", workingDirectory: "/other" });
      expect(projection.findProjectConversation("loaded")).toBeUndefined();
      expect(projection.findProjectConversation("new")).toBeDefined();
    } finally {
      observer.stop();
      projection[Symbol.dispose]();
    }
  });

  it("observes selected, visible, and running pins alongside the real four-session idle LRU", async () => {
    const projection = RootProjection.create();
    const root = mountRootStore(
      {} as Client,
      { state: {}, children: {} },
      async () => undefined,
      projection,
    );
    root.appShellStore.selectProjectSession("selected");
    root.sessionLayoutStore.ensureSession("visible");
    projection.projectConversation("running", "/project").streaming = true;
    for (const sessionId of [
      "selected",
      "visible",
      "running",
      "idle-0",
      "idle-1",
      "idle-2",
      "idle-3",
      "idle-4",
    ])
      root.sessionRegistry.load(sessionId, "/project");
    const conversations = vi.fn(({ sessionId }: { sessionId: string }) => {
      const update = conversationSnapshot(sessionId);
      return Stream.make({
        ...update,
        snapshot: { ...update.snapshot, streaming: sessionId === "running" },
      }).pipe(Stream.concat(Stream.never));
    });
    const { runtime, cancellations, applied } = recordingRuntime(
      baseClient({
        managedWorktrees: {
          observeCatalog: () => Stream.never,
          observeOperations: () => Stream.never,
        },
        conversations: { observe: conversations },
      }),
    );
    const stop = observeModels(runtime, projection, root);
    try {
      for (let index = 0; index < 7; index += 1) await Effect.runPromise(Queue.take(applied));
      expect(new Set(conversations.mock.calls.map(([target]) => target.sessionId))).toEqual(
        new Set(["selected", "visible", "running", "idle-1", "idle-2", "idle-3", "idle-4"]),
      );
      expect(projection.findProjectConversation("idle-0")?.observedSnapshotRevision).toBe(0);
      const count = cancellations.length;
      const ensure = vi.spyOn(projection, "projectConversation");
      batch(() => {
        root.appShellStore.selectProjectSession("idle-4");
        root.sessionRegistry.observationRetention.retain("idle-4");
      });
      expect(conversations).toHaveBeenCalledTimes(7);
      expect(cancellations).toHaveLength(count);
      expect(cancellations.every((cancel) => cancel.mock.calls.length === 0)).toBe(true);
      // All demanded identities remain hot; the loaded-registry reconciler is
      // independent of selection. Demand may consult focused staged metadata.
      expect(ensure.mock.calls.every(([id]) => id !== "idle-0")).toBe(true);

      // Losing a visible pin moves it into the idle LRU, evicting only its oldest
      // idle peer while selected/running projections stay authoritative.
      root.sessionLayoutStore.showSession("idle-4");
      expect(conversations).toHaveBeenCalledTimes(7);
      expect(cancellations.filter((cancel) => cancel.mock.calls.length > 0)).toHaveLength(4);
      expect(projection.findProjectConversation("idle-1")?.parts).toEqual([]);
      expect(projection.findProjectConversation("visible")?.observedSnapshotRevision).toBe(1);
      expect(projection.findProjectConversation("running")?.streaming).toBe(true);
      expect(projection.findProjectConversation("selected")?.observedSnapshotRevision).toBe(1);
    } finally {
      stop();
      root[Symbol.dispose]();
      projection[Symbol.dispose]();
    }
  });

  it("switches warm selection without traversing loaded identities or restarting unchanged streams", async () => {
    const loadedIds = observable(Array.from({ length: 100 }, (_, index) => `project-${index}`));
    const retainedIds = observable(["project-0", "project-1", "project-2"]);
    const selection = observable({ sessionId: "project-0" });
    const loadedTargets = vi.fn(() =>
      loadedIds.map((sessionId) => ({ sessionId, workingDirectory: "/project" })),
    );
    const conversations = vi.fn(({ sessionId }: { sessionId: string }) =>
      Stream.make(conversationSnapshot(sessionId)).pipe(Stream.concat(Stream.never)),
    );
    const projection = RootProjection.create();
    const client = baseClient({
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      conversations: { observe: conversations },
    });
    const { runtime, cancellations, applied } = recordingRuntime(client);
    const observer = createModelObserver(runtime);
    observer.observe({
      projection,
      projectSessionCatalogQueries: () => [],
      loadedProjectSessions: loadedTargets,
      projectSessionTargets: () => {
        const selected = selection.sessionId;
        return retainedIds
          .toSorted((left, right) => Number(right === selected) - Number(left === selected))
          .map((sessionId) => ({ sessionId, workingDirectory: "/project" }));
      },
      cakeChatTargets: () => [],
    });

    try {
      for (let index = 0; index < retainedIds.length; index += 1)
        await Effect.runPromise(Queue.take(applied));
      expect(conversations.mock.calls.map(([target]) => target.sessionId)).toEqual(retainedIds);
      const initialObservationCount = cancellations.length;
      const identity = projection.findProjectConversation("project-1");
      expect(identity?.observedSnapshotRevision).toBe(1);
      expect(identity?.sessionFile).toBe("/sessions/project-1.jsonl");
      const ensure = vi.spyOn(projection, "projectConversation");
      const traverse = vi.spyOn(projection.projectConversations, Symbol.iterator);
      traverse.mockClear();
      loadedTargets.mockClear();

      for (const sessionId of ["project-1", "project-2", "project-0", "project-1"]) {
        ensure.mockClear();
        selection.sessionId = sessionId;
        expect(ensure.mock.calls.map(([id]) => id).sort()).toEqual([...retainedIds].sort());
        expect(projection.findProjectConversation("project-1")).toBe(identity);
      }
      expect(loadedTargets).not.toHaveBeenCalled();
      expect(traverse).not.toHaveBeenCalled();
      expect(conversations).toHaveBeenCalledTimes(3);
      expect(cancellations).toHaveLength(initialObservationCount);
      expect(cancellations.every((cancel) => cancel.mock.calls.length === 0)).toBe(true);

      // A cold identity alone does not demand a transcript, then opening hydrates
      // the same Model while evicting just the former retained session's streams.
      loadedIds.push("cold");
      const cold = projection.findProjectConversation("cold");
      expect(cold?.observedSnapshotRevision).toBe(0);
      expect(cold?.parts).toEqual([]);
      expect(conversations).toHaveBeenCalledTimes(3);
      retainedIds.splice(0, 1, "cold");
      await Effect.runPromise(Queue.take(applied));
      expect(cancellations).toHaveLength(initialObservationCount + 4);
      expect(cancellations.filter((cancel) => cancel.mock.calls.length > 0)).toHaveLength(4);
      expect(conversations).toHaveBeenCalledTimes(4);
      expect(conversations.mock.calls[3]?.[0].sessionId).toBe("cold");
      expect(projection.findProjectConversation("cold")).toBe(cold);
      expect(cold?.observedSnapshotRevision).toBe(1);
      expect(projection.findProjectConversation("project-0")?.parts).toEqual([]);
      expect(identity?.observedSnapshotRevision).toBe(1);

      // True unload releases identity and focused projections; re-entry creates
      // a new Model and only its own four streams receive fresh snapshots.
      batch(() => {
        retainedIds.splice(0, 1);
        loadedIds.splice(loadedIds.indexOf("cold"), 1);
      });
      expect(projection.findProjectConversation("cold")).toBeUndefined();
      expect(projection.discussionCatalogs.some((model) => model.sessionId === "cold")).toBe(false);
      expect(projection.subagentCatalogs.some((model) => model.sessionId === "cold")).toBe(false);
      expect(projection.scheduledMessageCatalogs.some((model) => model.sessionId === "cold")).toBe(
        false,
      );
      batch(() => {
        loadedIds.push("cold");
        retainedIds.push("cold");
      });
      await Effect.runPromise(Queue.take(applied));
      expect(projection.findProjectConversation("cold")).not.toBe(cold);
      expect(projection.findProjectConversation("cold")?.observedSnapshotRevision).toBe(1);
      expect(conversations).toHaveBeenCalledTimes(5);
      expect(cancellations.filter((cancel) => cancel.mock.calls.length > 0)).toHaveLength(8);
      expect(identity?.observedSnapshotRevision).toBe(1);
    } finally {
      observer.stop();
      const observationsAfterStop = cancellations.length;
      loadedTargets.mockClear();
      selection.sessionId = "project-2";
      loadedIds.push("after-stop");
      expect(loadedTargets).not.toHaveBeenCalled();
      expect(cancellations).toHaveLength(observationsAfterStop);
      expect(projection.findProjectConversation("after-stop")).toBeUndefined();
      projection[Symbol.dispose]();
    }
  });

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
      discussionSessionDemand: retainedSessions,
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
