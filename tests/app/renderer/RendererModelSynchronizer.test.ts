import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCatalogUpdate, SessionCatalogUpdate } from "../../../src/domain/catalog-data";
import { ProjectSessionError } from "../../../src/domain/project-session-data";
import { CakeIpcClient, type CakeIpcClientService } from "../../../src/ipc/client/CakeIpcClient";
import { RendererModelSynchronizer } from "../../../src/renderer/RendererModelSynchronizer";
import type { RendererRuntime } from "../../../src/renderer/RendererRuntime";
import { ProjectCatalog } from "../../../src/renderer/models/ProjectCatalog";
import { CakeChatCatalog } from "../../../src/renderer/models/CakeChatCatalog";
import { SessionCatalog } from "../../../src/renderer/models/SessionCatalog";
import { Session } from "../../../src/renderer/models/Session";

function runtimeFor(client: CakeIpcClientService): RendererRuntime {
  return {
    runPromise: (effect, options) =>
      Effect.runPromise(Effect.provideService(effect, CakeIpcClient, client), options),
  } as RendererRuntime;
}

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

describe("RendererModelSynchronizer", () => {
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
    const synchronizer = new RendererModelSynchronizer(runtimeFor(client));

    synchronizer.sync({
      projects,
      sessionCatalog: sessions,
      cakeChatCatalog: cakeChats,
      projectSessions: [],
      cakeChats: [],
    });

    await vi.waitFor(() => expect(projects.projects[0]?.name).toBe("Cake Desktop"));
    const project = projects.projects[0];
    expect(projects.projects[0]).toBe(project);

    synchronizer[Symbol.dispose]();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
    cakeChats[Symbol.dispose]();
  });

  it("reconnects from a fresh Snapshot after a revision gap", async () => {
    let observations = 0;
    const first: ProjectCatalogUpdate[] = [
      { _tag: "Snapshot", revision: 1, projects: [] },
      {
        _tag: "Event",
        revision: 3,
        event: {
          _tag: "Upserted",
          project: {
            path: "/stale",
            name: "Stale",
            addedAt: "2026-01-01",
            lastOpenedAt: "2026-01-01",
          },
        },
      },
    ];
    const fresh: ProjectCatalogUpdate = {
      _tag: "Snapshot",
      revision: 10,
      projects: [
        {
          path: "/fresh",
          name: "Fresh",
          addedAt: "2026-01-02",
          lastOpenedAt: "2026-01-02",
        },
      ],
    };
    const client = clientWithProjectStream(() => {
      observations += 1;
      return observations === 1
        ? Stream.concat(Stream.fromIterable(first), Stream.never)
        : Stream.concat(Stream.make(fresh), Stream.never);
    });
    const projects = ProjectCatalog.create();
    const sessions = SessionCatalog.create();
    const cakeChats = CakeChatCatalog.create();
    const synchronizer = new RendererModelSynchronizer(runtimeFor(client));

    synchronizer.sync({
      projects,
      sessionCatalog: sessions,
      cakeChatCatalog: cakeChats,
      projectSessions: [],
      cakeChats: [],
    });

    await vi.waitFor(() =>
      expect(projects.projects.map((project) => project.path)).toEqual(["/fresh"]),
    );
    expect(observations).toBe(2);

    synchronizer[Symbol.dispose]();
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
    const synchronizer = new RendererModelSynchronizer(runtimeFor(client));

    synchronizer.sync({
      projects,
      sessionCatalog: sessions,
      cakeChatCatalog: cakeChats,
      projectSessions: [],
      cakeChats: [],
    });

    await vi.waitFor(() => expect(sessions.find("newer")?.resolved).toBe(true));
    expect(sessions.sessions.map((session) => session.sessionId)).toEqual(["older", "newer"]);

    synchronizer[Symbol.dispose]();
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
    const synchronizer = new RendererModelSynchronizer(runtimeFor(client));

    try {
      synchronizer.sync({
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
      synchronizer[Symbol.dispose]();
      projects[Symbol.dispose]();
      sessions[Symbol.dispose]();
      cakeChats[Symbol.dispose]();
      session[Symbol.dispose]();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
