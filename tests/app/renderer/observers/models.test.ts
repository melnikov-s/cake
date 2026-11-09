import { Effect, Queue, Stream } from "effect";
import { batch, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSessionSignalsUpdate } from "../../../../src/contracts/project-sessions/project-session-signals";
import type {
  DiscussionCatalogUpdate,
  SessionCatalogUpdate,
} from "../../../../src/contracts/application/catalog-data";
import type { DiscussionSessionUpdate } from "../../../../src/contracts/discussion-sessions/discussion-session-data";
import {
  SessionChatError,
  type ConversationUpdate,
} from "../../../../src/contracts/conversations/conversation-data";
import type { CakeChatControlUpdate } from "../../../../src/contracts/cake-chats/cake-chat-data";
import type { ProjectSessionCatalogQuery } from "../../../../src/contracts/project-sessions/project-session-data";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { applySessionSignalsUpdate } from "../../../../src/renderer/reducers/SessionSignalsReducer";
import { createModelObserver, observeModels } from "../../../../src/renderer/observers";
import type { Runtime } from "../../../../src/renderer/runtime";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import {
  observerClient,
  observerRuntime as runtimeFor,
  type ObserverClientOverrides,
} from "./observer-test-runtime";

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

function baseClient(overrides: ObserverClientOverrides = {}) {
  return observerClient({
    projects: { observeCatalog: () => Stream.never },
    automations: { observe: () => Stream.never },
    cakeChats: { observeCatalog: () => Stream.never },
    conversations: { observe: () => Stream.never },
    discussionSessions: { observeCatalog: () => Stream.never, observe: () => Stream.never },
    subagents: { observe: () => Stream.never },
    scheduledMessages: { observe: () => Stream.never },
    ...overrides,
    projectSessions: { observeSignals: () => Stream.never, ...overrides.projectSessions },
  });
}

describe("Project Session composition observer", () => {
  it("loads only the selected owner's delegated workflow details while To-dos stays open", async () => {
    const worker = sessionSummary({
      sessionId: "owned-worker",
      projectPath: "/project",
      title: "Owned work",
      cakeChatLaunch: { requesterSessionId: CAKE_CHAT_SESSION_ID },
    });
    const lookup = vi.fn(async () => worker);
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      client: { projectSessions: { lookup } },
    });
    const workflow = fixture.root.conversationActivityStore;
    applySessionSignalsUpdate(fixture.models.sessionCatalog, {
      _tag: "Snapshot",
      sessions: [
        {
          sessionId: worker.sessionId,
          projectPath: "/project",
          workingDirectory: "/project",
          running: true,
          unread: false,
          cakeChatLaunch: { requesterSessionId: CAKE_CHAT_SESSION_ID },
        },
        {
          sessionId: "unrelated-idle",
          projectPath: "/project",
          workingDirectory: "/project",
          running: false,
          unread: false,
        },
      ],
    });
    await vi.waitFor(() =>
      expect(workflow.sessionsFor(CAKE_CHAT_SESSION_ID)).toEqual([
        expect.objectContaining({
          sessionId: worker.sessionId,
          title: "Owned work",
          status: "running",
        }),
      ]),
    );
    expect(lookup).toHaveBeenCalledOnce();
    expect(fixture.root.workspaceNavigatorStore.mode).toBe("todos");
    expect(fixture.root.sidebarStore.sessionListStore.projectSessionCatalogQueries).toEqual([]);
    expect(fixture.root.sessionMetadataStore.exists("unrelated-idle")).toBe(true);
    applySessionSignalsUpdate(fixture.models.sessionCatalog, {
      _tag: "Upserted",
      session: {
        sessionId: worker.sessionId,
        projectPath: "/project",
        workingDirectory: "/project",
        running: false,
        unread: false,
        latestTurnOutcome: "complete",
        cakeChatLaunch: { requesterSessionId: CAKE_CHAT_SESSION_ID },
      },
    });
    expect(fixture.root.sessionMetadataStore.sessionWorkActivity(worker.sessionId)).toBe("ready");
    expect(workflow.sessionsFor(CAKE_CHAT_SESSION_ID)[0]?.status).toBe("done");
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("defers list snapshots until Sessions opens, releases them on exit, and keeps background signals live", async () => {
    const alpha = sessionSummary({
      sessionId: "alpha",
      projectPath: "/project",
      title: "Current alpha",
    });
    const beta = sessionSummary({
      sessionId: "beta",
      projectPath: "/other",
      title: "Current beta",
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" }), projectRecord({ path: "/other" })],
      client: { projectSessions: { lookup: async () => alpha, open: async () => {} } },
    });
    const signals = Effect.runSync(Queue.unbounded<ProjectSessionSignalsUpdate>());
    const signalStream = vi.fn(() => Stream.fromQueue(signals));
    let revision = 0;
    let freshTitle = alpha.title;
    const ended: string[] = [];
    const catalogs = vi.fn((query: ProjectSessionCatalogQuery) =>
      Stream.succeed({
        _tag: "Snapshot" as const,
        revision: ++revision,
        sessions: [query.projectPath === "/project" ? { ...alpha, title: freshTitle } : beta],
      }).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(
          Effect.sync(() => {
            ended.push(query.projectPath);
          }),
        ),
      ),
    );
    const client = baseClient({
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      projectSessions: { observeCatalog: catalogs, observeSignals: signalStream },
      conversations: {
        observe: (target) =>
          Stream.succeed(conversationSnapshot(target.sessionId)).pipe(Stream.concat(Stream.never)),
      },
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeControls: () => Stream.never,
        observeSideChats: () => Stream.never,
        observeSideChatMetadata: () => Stream.never,
      },
      discussionSessions: {
        observeCatalog: () => Stream.never,
        observeMetadata: () => Stream.never,
      },
      subagents: { observe: () => Stream.never, observeMetadata: () => Stream.never },
    });
    const stop = observeModels(runtimeFor(client), fixture.models, fixture.root);
    try {
      Queue.offerUnsafe(signals, {
        _tag: "Snapshot",
        sessions: [
          {
            sessionId: "alpha",
            projectPath: "/project",
            workingDirectory: "/project",
            running: true,
            unread: false,
          },
          {
            sessionId: "beta",
            projectPath: "/other",
            workingDirectory: "/other",
            running: false,
            unread: true,
            latestTurnOutcome: "failed",
          },
        ],
      });
      await vi.waitFor(() => expect(fixture.models.sessionCatalog.signals.loaded).toBe(true));
      expect(fixture.root.workspaceNavigatorStore.mode).toBe("todos");
      expect(catalogs).not.toHaveBeenCalled();
      expect(fixture.models.sessionCatalog.sessions).toHaveLength(0);
      expect(fixture.root.sessionMetadataStore.sessionActivity("alpha")).toBe("running");
      expect(fixture.root.conversationNavigatorStore.projectUnread("/other")).toBe(true);
      expect(fixture.root.sidebarStore.sessionListStore.projectHasError("/other")).toBe(true);
      expect(fixture.root.conversationNavigatorStore.summaryCounts()).toMatchObject({
        running: 1,
        unread: 1,
      });
      expect(fixture.root.sidebarStore.sessionListStore.adjacentActiveSession("next")).toEqual({
        kind: "project-session",
        sessionId: "alpha",
      });
      expect(fixture.models.projectConversations).toHaveLength(0);

      fixture.root.workspaceNavigatorStore.show("sessions");
      await vi.waitFor(() => expect(fixture.models.sessionCatalog.sessions).toHaveLength(2));
      expect(catalogs).toHaveBeenCalledTimes(2);
      expect(
        fixture.root.conversationNavigatorStore.tree(undefined).byKey.get("session:alpha")?.title,
      ).toBe("Current alpha");
      fixture.root.workspaceNavigatorStore.show("sessions");
      expect(catalogs).toHaveBeenCalledTimes(2);
      fixture.root.workspaceNavigatorStore.show("todos");
      await vi.waitFor(() => expect(ended).toHaveLength(2));
      Queue.offerUnsafe(signals, {
        _tag: "Upserted",
        session: {
          sessionId: "alpha",
          projectPath: "/project",
          workingDirectory: "/project",
          running: false,
          unread: true,
          latestTurnOutcome: "complete",
        },
      });
      await vi.waitFor(() =>
        expect(fixture.root.sessionMetadataStore.sessionActivity("alpha")).toBe("unread"),
      );
      expect(catalogs).toHaveBeenCalledTimes(2);
      expect(signalStream).toHaveBeenCalledOnce();

      freshTitle = "Fresh reentry title";
      fixture.root.workspaceNavigatorStore.show("sessions");
      await vi.waitFor(() => expect(catalogs).toHaveBeenCalledTimes(4));
      await vi.waitFor(() =>
        expect(fixture.models.sessionCatalog.find("alpha")?.title).toBe("Fresh reentry title"),
      );
      fixture.root.workspaceNavigatorStore.close();
      await vi.waitFor(() => expect(ended).toHaveLength(4));
      await fixture.root.navigationStore.openSessionLink("alpha");
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("alpha");
      expect(fixture.root.workspaceNavigatorStore.visible).toBe(false);
      expect(catalogs).toHaveBeenCalledTimes(4);
      expect(signalStream).toHaveBeenCalledOnce();
      fixture.root.workspaceNavigatorStore.show("sessions");
      await vi.waitFor(() => expect(catalogs).toHaveBeenCalledTimes(5));
      expect(catalogs.mock.calls[4]?.[0]).toEqual({ projectPath: "/project", resolved: false });
      fixture.root.workspaceNavigatorStore.close();
      await vi.waitFor(() => expect(ended).toHaveLength(5));
      fixture.root.sidebarStore.sessionSearchStore.show();
      await vi.waitFor(() => expect(catalogs).toHaveBeenCalledTimes(7));
      expect(fixture.root.workspaceNavigatorStore.visible).toBe(false);
      fixture.root.sidebarStore.sessionSearchStore.close();
      await vi.waitFor(() => expect(ended).toHaveLength(7));
      expect(signalStream).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("activates, replaces paged demand and releases collapsed archive subscriptions", async () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
    });
    const ended: ProjectSessionCatalogQuery[] = [];
    const catalogs = vi.fn((query: ProjectSessionCatalogQuery) =>
      Stream.succeed({
        _tag: "Snapshot" as const,
        revision: 1,
        hasMore: query.resolved && (query.limit ?? 10) < 12,
        sessions: query.resolved
          ? Array.from({ length: Math.min(query.limit ?? 10, 12) }, (_, index) =>
              sessionSummary({
                sessionId: `resolved-${index}`,
                projectPath: "/project",
                resolved: true,
              }),
            )
          : [],
      }).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(
          Effect.sync(() => {
            ended.push(query);
          }),
        ),
      ),
    );
    const client = baseClient({
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      projectSessions: { observeCatalog: catalogs },
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeSideChatMetadata: () => Stream.never,
      },
      subagents: { observe: () => Stream.never, observeMetadata: () => Stream.never },
    });
    fixture.root.workspaceNavigatorStore.show("sessions");
    const stop = observeModels(runtimeFor(client), fixture.models, fixture.root);
    const list = fixture.root.sidebarStore.sessionListStore;
    try {
      await vi.waitFor(() => expect(catalogs).toHaveBeenCalledTimes(1));
      expect(catalogs.mock.calls[0]?.[0].resolved).toBe(false);
      list.toggleResolvedGroupExpanded("/project");
      await vi.waitFor(() => expect(fixture.models.sessionCatalog.sessions).toHaveLength(10));
      expect(list.hasMoreResolvedProjectSessions("/project")).toBe(true);
      list.showMoreSessions("/project", true);
      await vi.waitFor(() => expect(fixture.models.sessionCatalog.sessions).toHaveLength(12));
      expect(list.hasMoreResolvedProjectSessions("/project")).toBe(false);
      expect(ended).toContainEqual({ projectPath: "/project", resolved: true, limit: 10 });
      list.toggleResolvedGroupExpanded("/project");
      await vi.waitFor(() => expect(fixture.models.sessionCatalog.sessions).toHaveLength(0));
      expect(ended).toContainEqual({ projectPath: "/project", resolved: true, limit: 20 });
      expect(catalogs.mock.calls.filter(([query]) => !query.resolved)).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("keeps startup independent of dormant-session metadata while project activity still arrives", async () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" }), projectRecord({ path: "/other" })],
      sessions: Array.from({ length: 30 }, (_, index) =>
        sessionSummary({
          sessionId: `cold-${index}`,
          projectPath: index % 2 ? "/project" : "/other",
        }),
      ),
    });
    fixture.root.workspaceNavigatorStore.close();
    const metadata = vi.fn<
      (input: { sessionId?: string; parentSessionId?: string }) => Stream.Stream<readonly never[]>
    >(() => Stream.succeed([]).pipe(Stream.concat(Stream.never)));
    const client = baseClient({
      projects: {
        observeCatalog: () =>
          Stream.succeed({
            _tag: "Event",
            revision: 1,
            event: { _tag: "ActivityChanged", runningProjectPaths: ["/other"] },
          } as const).pipe(Stream.concat(Stream.never)),
      },
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      projectSessions: { observeCatalog: () => Stream.never },
      cakeChats: { observeCatalog: () => Stream.never, observeSideChatMetadata: metadata },
      discussionSessions: { observeMetadata: metadata },
      subagents: { observe: () => Stream.never, observeMetadata: metadata },
    });
    const stop = observeModels(runtimeFor(client), fixture.models, fixture.root);
    try {
      await vi.waitFor(() =>
        expect(fixture.models.projects.runningProjectPaths).toEqual(["/other"]),
      );
      expect(metadata).not.toHaveBeenCalled();
      expect(fixture.models.discussionCatalogs.map((catalog) => catalog.sessionId)).toEqual([
        CAKE_CHAT_SESSION_ID,
      ]);
      expect(fixture.models.subagentCatalogs.map((catalog) => catalog.sessionId)).toEqual([
        CAKE_CHAT_SESSION_ID,
      ]);
      fixture.root.workspaceNavigatorStore.show("sessions");
      await vi.waitFor(() => expect(metadata).toHaveBeenCalled());
      expect(
        metadata.mock.calls.every(
          ([input]) =>
            input.sessionId === "ca4ec4a7-0000-4000-8000-000000000001" ||
            input.parentSessionId === "ca4ec4a7-0000-4000-8000-000000000001",
        ),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it("retains a hidden Project Chat's history until its loaded identity is removed", async () => {
    using projection = RootProjection.create();
    const first = `project-chat:${"a".repeat(64)}`;
    const second = `project-chat:${"b".repeat(64)}`;
    const loaded = observable([first, second]);
    const selected = observable({ id: first });
    const client = baseClient({
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      conversations: {
        observe: (target) =>
          Stream.succeed(conversationSnapshot(target.sessionId)).pipe(Stream.concat(Stream.never)),
      },
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeSideChats: () => Stream.never,
        observeControls: () => Stream.never,
      },
    });
    const observer = createModelObserver(runtimeFor(client));
    observer.observe({
      projection,
      loadedCakeChatIds: () => loaded,
      projectSessionCatalogQueries: () => [],
      projectSessionTargets: () => [],
      cakeChatTargets: () => [{ sessionId: selected.id, tools: [] }],
    });
    try {
      await vi.waitFor(() =>
        expect(projection.cakeChatConversation(first).sessionFile).not.toBe(""),
      );
      const history = projection.cakeChatConversation(first).uiParts;
      selected.id = second;
      await vi.waitFor(() =>
        expect(projection.cakeChatConversation(second).sessionFile).not.toBe(""),
      );
      expect(projection.cakeChatConversation(first).sessionFile).toBe(`/sessions/${first}.jsonl`);
      expect(projection.cakeChatConversation(first).uiParts).toEqual(history);
      loaded.splice(0, 1);
      expect(projection.cakeChatConversations.map((model) => model.sessionId)).toEqual([second]);
    } finally {
      observer.stop();
    }
  });

  it("delivers a title event to the pending projection before a file-backed catalog entry exists", async () => {
    const updates = await Effect.runPromise(Queue.unbounded<ProjectSessionSignalsUpdate>());
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project", name: "Project" })],
    });
    const { root, models: projection } = fixture;
    root.sessionRegistry.pendingSessions.prepare("/project", "new-session");
    root.sessionRegistry.pendingSessions.materialize("new-session", "/project");
    const client = baseClient({
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      projectSessions: {
        observeCatalog: () => Stream.never,
        observeSignals: () => Stream.fromQueue(updates),
      },
    });
    const stop = observeModels(runtimeFor(client), projection, root);
    try {
      await Effect.runPromise(Queue.offer(updates, { _tag: "Snapshot", sessions: [] }));
      await Effect.runPromise(
        Queue.offer(updates, {
          _tag: "TitleChanged",
          sessionId: "new-session",
          title: "Generated title",
        }),
      );
      await vi.waitFor(() =>
        expect(root.sessionRegistry.pendingSessions.summaries).toEqual([
          expect.objectContaining({
            sessionId: "new-session",
            title: "Generated title",
            pending: true,
          }),
        ]),
      );
      expect(projection.sessionCatalog.sessions).toHaveLength(0);
    } finally {
      stop();
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
    );

    try {
      observer.sync(baseInput(projection));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observes).toHaveBeenCalledOnce();
      expect(projection.projectConversation("project-1", "/project").observationError).toBe(
        "That session is no longer available",
      );
      observer.sync(baseInput(projection));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observes).toHaveBeenCalledTimes(2);
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

// Retain identity/lifetime and traversal-cost regressions at the projection boundary:
// React cannot prove absence of O(loaded sessions) work or exact stream disposal.
// Internal spies below only measure traversal; they do not replace Models or Stores.
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

  it("observes focused and running pins alongside the real four-session idle LRU", async () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        "selected",
        "running",
        "idle-0",
        "idle-1",
        "idle-2",
        "idle-3",
        "idle-4",
        "replacement",
      ].map((sessionId) => sessionSummary({ sessionId, projectPath: "/project" })),
    });
    const projection = fixture.models;
    const root = fixture.root;
    root.navigationStore.selectProjectSession("selected");
    projection.projectConversation("running", "/project").streaming = true;
    for (const sessionId of [
      "selected",
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
      // The permanent startup chat is retained independently of the Project idle LRU.
      for (let index = 0; index < 7; index += 1) await Effect.runPromise(Queue.take(applied));
      expect(new Set(conversations.mock.calls.map(([target]) => target.sessionId))).toEqual(
        new Set([
          CAKE_CHAT_SESSION_ID,
          "selected",
          "running",
          "idle-1",
          "idle-2",
          "idle-3",
          "idle-4",
        ]),
      );
      expect(projection.findProjectConversation("idle-0")?.observedSnapshotRevision).toBe(0);
      const count = cancellations.length;
      batch(() => {
        root.navigationStore.selectProjectSession("idle-4");
        root.sessionRegistry.observationRetention.retain("idle-4");
      });
      expect(conversations).toHaveBeenCalledTimes(7);
      expect(cancellations).toHaveLength(count);
      expect(cancellations.every((cancel) => cancel.mock.calls.length === 0)).toBe(true);
      // Inspecting navigator metadata does not demand an idle conversation stream.
      expect(projection.findProjectConversation("idle-0")?.observedSnapshotRevision).toBe(0);

      // Losing a focused pin moves it into the idle LRU, evicting only its oldest
      // idle peer while selected/running projections stay authoritative.
      batch(() => {
        root.navigationStore.selectProjectSession("replacement");
        root.sessionRegistry.load("replacement", "/project");
      });
      expect(conversations).toHaveBeenCalledTimes(8);
      // Conversation, discussions, schedules and subagents.
      expect(cancellations.filter((cancel) => cancel.mock.calls.length > 0)).toHaveLength(4);
      expect(projection.findProjectConversation("idle-1")?.parts).toEqual([]);
      expect(projection.findProjectConversation("idle-4")?.observedSnapshotRevision).toBe(1);
      expect(projection.findProjectConversation("running")?.streaming).toBe(true);
      expect(projection.findProjectConversation("selected")?.observedSnapshotRevision).toBe(1);
    } finally {
      stop();
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
    const catalogUpdates = await Effect.runPromise(Queue.unbounded<DiscussionCatalogUpdate>());
    const sidecarObservations: Queue.Queue<DiscussionSessionUpdate>[] = [];
    using fixture = createRendererStoreFixture();
    const { root, models: projection } = fixture;
    root.sessionRegistry.load(parentId, "/project");
    const catalog = projection.discussionCatalog(parentId);
    const reviews = root.reviewsStore;
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
    const stop = observeModels(runtimeFor(client), projection, root);

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

      // The real Registry keeps identity loaded while both consumers lose retention.
      root.sessionRegistry.observationRetention.remove(parentId);
      await vi.waitFor(() => expect(reviews.discussionSessions).toHaveLength(0));
      await vi.waitFor(() => expect(sidecarModel?.parts).toEqual([]));
      expect(projection.findDiscussionConversation(sidecarId)).toBe(sidecarModel);
      expect(projection.discussionCatalog(parentId).threads).toHaveLength(1);

      root.sessionRegistry.load(parentId, "/project");
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
      root.sessionRegistry.removeSession(parentId);
      await vi.waitFor(() => expect(reviews.discussionSessions).toHaveLength(0));
      await vi.waitFor(() =>
        expect(projection.findDiscussionConversation(sidecarId)).toBeUndefined(),
      );
      expect(
        projection.discussionCatalogs.filter((item) => item.sessionId === parentId),
      ).toHaveLength(0);

      root.sessionRegistry.load(parentId, "/project");
      await vi.waitFor(() =>
        expect(
          projection.discussionCatalogs.filter((item) => item.sessionId === parentId),
        ).toHaveLength(1),
      );
      const reloadedCatalog = projection.discussionCatalog(parentId);
      expect(reloadedCatalog).not.toBe(catalog);
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
      stop();
    }
  });
});

describe("Cake Chat composition observer", () => {
  it("projects scheduled messages addressed to a Cake Chat and clears them when it unloads", async () => {
    const observed: string[] = [];
    const message = {
      id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
      targetSessionId: "cake-chat-1",
      text: "Check the PR status",
      sendAt: "2030-01-01T12:00:00.000Z",
      createdAt: "2030-01-01T11:57:00.000Z",
      repeatEverySeconds: 180,
    };
    const client = baseClient({
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeSideChats: () => Stream.never,
        observeControls: () => Stream.never,
      },
      scheduledMessages: {
        observe: (targetSessionId: string) => {
          observed.push(targetSessionId);
          return Stream.make({ _tag: "Snapshot" as const, revision: 1, messages: [message] }).pipe(
            Stream.concat(Stream.never),
          );
        },
      },
    });
    const projection = RootProjection.create();
    const observer = createModelObserver(runtimeFor(client));
    const schedules = projection.scheduledMessageCatalog("cake-chat-1");
    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [
        {
          target: { sessionId: "cake-chat-1", tools: [] },
          conversation: projection.cakeChatConversation("cake-chat-1"),
          controls: projection.controlsForCakeChat("cake-chat-1"),
          subagents: projection.subagentCatalog("cake-chat-1"),
          schedules,
          sideChats: projection.discussionCatalog("cake-chat-1"),
        },
      ],
    });
    await vi.waitFor(() =>
      expect(schedules.messages.map((item) => item.repeatEverySeconds)).toEqual([180]),
    );
    expect(observed).toEqual(["cake-chat-1"]);
    projection.removeCakeChatProjections("cake-chat-1");
    expect(projection.scheduledMessageCatalogs).toEqual([]);
    observer.stop();
    projection[Symbol.dispose]();
  });

  it("clears stopped controls and replays only current pending requests on re-entry", async () => {
    const controls = await Effect.runPromise(Queue.unbounded<CakeChatControlUpdate>());
    let currentRequests: CakeChatControlUpdate["requests"] = [];
    const client = baseClient({
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeSideChats: () => Stream.never,
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
          subagents: projection.subagentCatalog("cake-chat-1"),
          schedules: projection.scheduledMessageCatalog("cake-chat-1"),
          sideChats: projection.discussionCatalog("cake-chat-1"),
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
          subagents: projection.subagentCatalog("cake-chat-1"),
          schedules: projection.scheduledMessageCatalog("cake-chat-1"),
          sideChats: projection.discussionCatalog("cake-chat-1"),
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
          subagents: projection.subagentCatalog("cake-chat-1"),
          schedules: projection.scheduledMessageCatalog("cake-chat-1"),
          sideChats: projection.discussionCatalog("cake-chat-1"),
        },
      ],
    });
    await vi.waitFor(() => expect(controlModel.requests).toEqual([stillPending]));
    expect(controlModel.requests).toHaveLength(1);

    observer.stop();
    projection[Symbol.dispose]();
  });
});
