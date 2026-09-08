import { Effect, Queue, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../../../src/domain/catalog-data";
import { TurnId, type ConversationSnapshot } from "../../../../src/domain/conversation-data";
import {
  ProjectSessionError,
  type ProjectSessionUpdate,
} from "../../../../src/domain/project-session-data";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { createModelObserver, observeStream } from "../../../../src/renderer/observers";
import type { Runtime } from "../../../../src/renderer/runtime";
import { ProjectCatalog } from "../../../../src/renderer/models/ProjectCatalog";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { Session } from "../../../../src/renderer/models/Session";

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

const observerFor = (client: CakeIpcClientService) => createModelObserver(runtimeFor(client));

const emptySessionCatalog: SessionCatalogUpdate = {
  _tag: "Snapshot",
  revision: 1,
  sessions: [],
};

function clientWithProjectStream(
  observeCatalog: () => Stream.Stream<ProjectCatalogUpdate, unknown>,
): CakeIpcClientService {
  return {
    projects: { observeCatalog },
    scheduledMessages: {
      observe: () =>
        Stream.concat(
          Stream.make({ _tag: "Snapshot" as const, revision: 1, messages: [] }),
          Stream.never,
        ),
    },
    projectSessions: {
      observeCatalog: () => Stream.concat(Stream.make(emptySessionCatalog), Stream.never),
    },
    cakeChats: {
      observeCatalog: () =>
        Stream.concat(
          Stream.make({ _tag: "Snapshot" as const, revision: 1, sessions: [] }),
          Stream.never,
        ),
    },
  } as unknown as CakeIpcClientService;
}

describe("createModelObserver", () => {
  it("allows an unhydrated session placeholder to observe its final Working Directory", async () => {
    const targets: Array<{ sessionId: string; workingDirectory?: string }> = [];
    const client = {
      ...clientWithProjectStream(() => Stream.never),
      projectSessions: {
        observeCatalog: () => Stream.concat(Stream.make(emptySessionCatalog), Stream.never),
        observe: (target: { sessionId: string; workingDirectory?: string }) => {
          targets.push(target);
          return Stream.never;
        },
      },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const session = Session.create({ sessionId: "session", workingDirectory: "/project" });
    const observer = observerFor(client);

    observer.sync({
      projects,
      sessionCatalog: sessions,
      projectSessionCatalogQueries: [{ projectPath: "/cake", resolved: false }],
      cakeChatCatalog: cakeChats,
      projectSessions: [
        { target: { sessionId: "session", workingDirectory: "/worktree" }, model: session },
      ],
      cakeChats: [],
    });

    await vi.waitFor(() =>
      expect(targets).toContainEqual({ sessionId: "session", workingDirectory: "/worktree" }),
    );

    observer.stop();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
    session[Symbol.dispose]();
  });

  it("maps one current-first stream into stable reactive Models with applySnapshot", async () => {
    const updates: ProjectCatalogUpdate[] = [
      {
        _tag: "Snapshot",
        revision: 1,
        projects: [
          { path: "/cake", name: "Cake", addedAt: "2026-01-01", lastOpenedAt: "2026-01-01" },
        ],
      },
      {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "Upserted",
          project: {
            path: "/cake",
            name: "Cake Desktop",
            addedAt: "2026-01-01",
            lastOpenedAt: "2026-01-02",
          },
        },
      },
    ];
    const client = clientWithProjectStream(() =>
      Stream.concat(Stream.fromIterable(updates), Stream.never),
    );
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const observer = observerFor(client);

    observer.sync({
      projects,
      sessionCatalog: sessions,
      projectSessionCatalogQueries: [{ projectPath: "/cake", resolved: false }],
      cakeChatCatalog: cakeChats,
      projectSessions: [],
      cakeChats: [],
    });

    await vi.waitFor(() => expect(projects.projects[0]?.name).toBe("Cake Desktop"));
    const project = projects.projects[0];
    expect(projects.projects[0]).toBe(project);

    observer.stop();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
  });

  it("projects an accepted Pi turn before streaming begins", async () => {
    const conversation: ConversationSnapshot = {
      workingDirectory: "/cake",
      sessionId: "session",
      sessionFile: "/cake/session.jsonl",
      parts: [],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    };
    const turnId = TurnId.make("123e4567-e89b-42d3-a456-426614174000");
    const updates: ProjectSessionUpdate[] = [
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          identity: {
            _tag: "ProjectSession",
            sessionId: "session",
            projectPath: "/cake",
            workingDirectory: "/cake",
          },
          projectName: "Cake",
          resolved: false,
          unread: false,
          conversation,
        },
      },
      {
        _tag: "Event",
        revision: 2,
        sessionId: "session",
        event: {
          _tag: "TurnAccepted",
          sessionId: "session",
          turnId,
          delivery: "prompt",
        },
      },
    ];
    const client = {
      ...clientWithProjectStream(() => Stream.never),
      projectSessions: {
        observeCatalog: () => Stream.concat(Stream.make(emptySessionCatalog), Stream.never),
        observe: () => Stream.concat(Stream.fromIterable(updates), Stream.never),
      },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const session = Session.create({ sessionId: "session", workingDirectory: "/cake" });
    const observer = observerFor(client);

    observer.sync({
      projects,
      sessionCatalog: sessions,
      cakeChatCatalog: cakeChats,
      projectSessions: [
        { target: { sessionId: "session", workingDirectory: "/cake" }, model: session },
      ],
      cakeChats: [],
    });

    await vi.waitFor(() => expect(session.activeTurnIds).toEqual([turnId]));
    expect(session.streaming).toBe(false);

    observer.stop();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
    session[Symbol.dispose]();
  });

  it("mutates an existing Message in place for incremental part updates", async () => {
    const updates = Effect.runSync(Queue.unbounded<ProjectSessionUpdate>());
    const conversation: ConversationSnapshot = {
      workingDirectory: "/cake",
      sessionId: "session",
      sessionFile: "/cake/session.jsonl",
      parts: [
        {
          id: "assistant-text",
          kind: "text",
          role: "assistant",
          text: "Hello",
          status: "streaming",
        },
      ],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: true,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    };
    const client = {
      ...clientWithProjectStream(() => Stream.never),
      projectSessions: {
        observeCatalog: () => Stream.concat(Stream.make(emptySessionCatalog), Stream.never),
        observe: () => Stream.fromQueue(updates),
      },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const session = Session.create({ sessionId: "session", workingDirectory: "/cake" });
    const observer = observerFor(client);

    observer.sync({
      projects,
      sessionCatalog: sessions,
      cakeChatCatalog: cakeChats,
      projectSessions: [
        { target: { sessionId: "session", workingDirectory: "/cake" }, model: session },
      ],
      cakeChats: [],
    });
    await Effect.runPromise(
      Queue.offer(updates, {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          identity: {
            _tag: "ProjectSession",
            sessionId: "session",
            projectPath: "/cake",
            workingDirectory: "/cake",
          },
          projectName: "Cake",
          resolved: false,
          unread: false,
          conversation,
        },
      }),
    );
    await vi.waitFor(() => expect(session.parts[0]?.text).toBe("Hello"));
    const message = session.parts[0];

    await Effect.runPromise(
      Queue.offer(updates, {
        _tag: "Event",
        revision: 2,
        sessionId: "session",
        event: {
          _tag: "PartUpdated",
          sessionId: "session",
          part: {
            id: "assistant-text",
            kind: "text",
            role: "assistant",
            text: "Hello, world",
            status: "streaming",
          },
        },
      }),
    );

    await vi.waitFor(() => expect(session.parts[0]?.text).toBe("Hello, world"));
    expect(session.parts[0]).toBe(message);

    await Effect.runPromise(
      Queue.offer(updates, {
        _tag: "Event",
        revision: 3,
        sessionId: "session",
        event: {
          _tag: "TurnSettled",
          sessionId: "session",
          turnId: TurnId.make("123e4567-e89b-42d3-a456-426614174001"),
          outcome: "complete",
        },
      }),
    );
    await vi.waitFor(() => expect(session.settledTurnRevision).toBe(1));

    observer.stop();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
    session[Symbol.dispose]();
  });

  it("applies a source stream in emitted order without managing its revisions", async () => {
    let observations = 0;
    const updates: ProjectCatalogUpdate[] = [
      { _tag: "Snapshot", revision: 1, projects: [] },
      {
        _tag: "Event",
        revision: 3,
        event: {
          _tag: "Upserted",
          project: {
            path: "/cake",
            name: "Cake",
            addedAt: "2026-01-01",
            lastOpenedAt: "2026-01-01",
          },
        },
      },
    ];
    const client = clientWithProjectStream(() => {
      observations += 1;
      return Stream.concat(Stream.fromIterable(updates), Stream.never);
    });
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const observer = observerFor(client);

    observer.sync({
      projects,
      sessionCatalog: sessions,
      cakeChatCatalog: cakeChats,
      projectSessions: [],
      cakeChats: [],
    });

    await vi.waitFor(() =>
      expect(projects.projects.map((project) => project.path)).toEqual(["/cake"]),
    );
    expect(observations).toBe(1);

    observer.stop();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
  });

  it("updates and reorders one resolved Session summary", async () => {
    const sessionUpdates: SessionCatalogUpdate[] = [
      {
        _tag: "Snapshot",
        revision: 1,
        sessions: [
          {
            sessionId: "older",
            title: "Older",
            createdAt: "2026-01-01",
            modifiedAt: "2026-01-01",
            messageCount: 1,
            resolved: false,
            unread: false,
            projectPath: "/cake",
            projectName: "Cake",
            workingDirectory: "/cake",
          },
          {
            sessionId: "newer",
            title: "Newer",
            createdAt: "2026-01-02",
            modifiedAt: "2026-01-02",
            messageCount: 1,
            resolved: false,
            unread: false,
            projectPath: "/cake",
            projectName: "Cake",
            workingDirectory: "/cake",
          },
        ],
      },
      {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "StatusChanged",
          sessionId: "newer",
          resolved: true,
          unread: false,
        },
      },
    ];
    const client = {
      ...clientWithProjectStream(() => Stream.never),
      projectSessions: {
        observeCatalog: () => Stream.concat(Stream.fromIterable(sessionUpdates), Stream.never),
      },
    } as unknown as CakeIpcClientService;
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const observer = observerFor(client);

    observer.sync({
      projects,
      sessionCatalog: sessions,
      projectSessionCatalogQueries: [{ projectPath: "/cake", resolved: false }],
      cakeChatCatalog: cakeChats,
      projectSessions: [],
      cakeChats: [],
    });

    await vi.waitFor(() => expect(sessions.find("newer")?.resolved).toBe(true));
    expect(sessions.sessions.map((session) => session.sessionId)).toEqual(["older", "newer"]);

    observer.stop();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
  });

  it("unloads a Project Session catalog group when its demand disappears", async () => {
    const update: SessionCatalogUpdate = {
      _tag: "Snapshot",
      revision: 1,
      sessions: [
        {
          sessionId: "visible",
          title: "Visible",
          createdAt: "2026-01-01",
          modifiedAt: "2026-01-01",
          messageCount: 0,
          resolved: false,
          unread: false,
          projectPath: "/cake",
          projectName: "Cake",
          workingDirectory: "/cake",
        },
      ],
    };
    const client = {
      ...clientWithProjectStream(() => Stream.never),
      projectSessions: {
        observeCatalog: () => Stream.concat(Stream.make(update), Stream.never),
      },
    } as unknown as CakeIpcClientService;
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const observer = observerFor(client);
    const base = {
      projects,
      sessionCatalog: sessions,
      cakeChatCatalog: cakeChats,
      projectSessions: [],
      cakeChats: [],
    };

    observer.sync({
      ...base,
      projectSessionCatalogQueries: [{ projectPath: "/cake", resolved: false }],
    });
    await vi.waitFor(() => expect(sessions.find("visible")).toBeDefined());

    observer.sync({ ...base, projectSessionCatalogQueries: [] });
    expect(sessions.find("visible")).toBeUndefined();

    observer.stop();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
  });

  it("stops an observation when its Project Session has been archived", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let observations = 0;
    const client = {
      ...clientWithProjectStream(() => Stream.never),
      projectSessions: {
        observeCatalog: () => Stream.concat(Stream.make(emptySessionCatalog), Stream.never),
        observe: () => {
          observations += 1;
          return observations === 1
            ? Stream.fail(
                new ProjectSessionError({
                  operation: "observe",
                  message: "That session is no longer available",
                }),
              )
            : Stream.never;
        },
      },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const session = Session.create({ sessionId: "archived", workingDirectory: "/cake" });
    const observer = observerFor(client);

    try {
      observer.sync({
        projects,
        sessionCatalog: sessions,
        cakeChatCatalog: cakeChats,
        projectSessions: [
          {
            target: { sessionId: "archived", workingDirectory: "/cake" },
            model: session,
          },
        ],
        cakeChats: [],
      });

      await vi.advanceTimersByTimeAsync(300);

      expect(observations).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      observer.stop();
      projects[Symbol.dispose]();
      sessions[Symbol.dispose]();
      cakeChats[Symbol.dispose]();
      session[Symbol.dispose]();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("recovers a Project Session subscription after a schema failure", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let observations = 0;
    let schemaError: unknown;
    try {
      Schema.decodeUnknownSync(Schema.Json)(undefined);
    } catch (error) {
      schemaError = error;
    }
    const update: ProjectSessionUpdate = {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        identity: {
          _tag: "ProjectSession",
          sessionId: "session",
          projectPath: "/cake",
          workingDirectory: "/cake",
        },
        projectName: "Cake",
        resolved: false,
        unread: false,
        conversation: {
          workingDirectory: "/cake",
          sessionId: "session",
          sessionFile: "/cake/session.jsonl",
          parts: [
            {
              id: "user-message",
              kind: "text",
              role: "user",
              text: "hello",
              status: "complete",
            },
          ],
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      },
    };
    const client = {
      ...clientWithProjectStream(() => Stream.never),
      projectSessions: {
        observeCatalog: () => Stream.concat(Stream.make(emptySessionCatalog), Stream.never),
        observe: () => {
          observations += 1;
          return observations === 1
            ? Stream.fail(schemaError)
            : Stream.concat(Stream.make(update), Stream.never);
        },
      },
      discussionSessions: { observeCatalog: () => Stream.never },
      subagents: { observe: () => Stream.never },
    } as unknown as CakeIpcClientService;
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const session = Session.create({ sessionId: "session", workingDirectory: "/cake" });
    const observer = observerFor(client);

    try {
      observer.sync({
        projects,
        sessionCatalog: sessions,
        cakeChatCatalog: cakeChats,
        projectSessions: [
          { target: { sessionId: "session", workingDirectory: "/cake" }, model: session },
        ],
        cakeChats: [],
      });

      await vi.waitFor(() => expect(observations).toBe(1));
      await vi.waitFor(() => expect(consoleError.mock.calls[0]?.[1]).toBe(schemaError));
      await vi.advanceTimersByTimeAsync(250);

      await vi.waitFor(() =>
        expect(session.uiParts[0]).toMatchObject({
          kind: "text",
          role: "user",
          text: "hello",
        }),
      );
      expect(observations).toBe(2);
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      observer.stop();
      projects[Symbol.dispose]();
      sessions[Symbol.dispose]();
      cakeChats[Symbol.dispose]();
      session[Symbol.dispose]();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
