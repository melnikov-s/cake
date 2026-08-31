import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCatalogUpdate, SessionCatalogUpdate } from "../../../src/domain/catalog-data";
import { CakeIpcClient, type CakeIpcClientService } from "../../../src/ipc/client/CakeIpcClient";
import { RendererModelSynchronizer } from "../../../src/renderer/RendererModelSynchronizer";
import type { RendererRuntime } from "../../../src/renderer/RendererRuntime";
import { ProjectCatalog } from "../../../src/renderer/models/ProjectCatalog";
import { SessionCatalog } from "../../../src/renderer/models/SessionCatalog";

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
    const synchronizer = new RendererModelSynchronizer(runtimeFor(client));

    synchronizer.sync({
      projects,
      sessionCatalog: sessions,
      projectSessions: [],
      cakeChats: [],
      discussions: [],
    });

    await vi.waitFor(() => expect(projects.projects[0]?.name).toBe("Cake Desktop"));
    const project = projects.projects[0];
    expect(projects.projects[0]).toBe(project);

    synchronizer[Symbol.dispose]();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
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
    const synchronizer = new RendererModelSynchronizer(runtimeFor(client));

    synchronizer.sync({
      projects,
      sessionCatalog: sessions,
      projectSessions: [],
      cakeChats: [],
      discussions: [],
    });

    await vi.waitFor(() =>
      expect(projects.projects.map((project) => project.path)).toEqual(["/fresh"]),
    );
    expect(observations).toBe(2);

    synchronizer[Symbol.dispose]();
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
  });
});
