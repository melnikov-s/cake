import { applySnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { mountRootStore } from "../../../../src/renderer/bootstrap/mount-root-store";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";

const projectPath = "/projects/example";
const worktreePath = "/projects/.cake-worktrees/example-task";

const sessionSummary = (sessionId: string, workingDirectory: string) => ({
  sessionId,
  title: sessionId,
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  resolved: false,
  unread: false,
  projectPath,
  projectName: "Example",
  workingDirectory,
  pending: false,
  draft: false,
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((complete) => (resolve = complete)),
    resolve,
  };
}

describe("RootStore session navigation", () => {
  it("opens projected family children in one reusable pane", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("parent", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const open = vi.fn(async () => undefined);
    const respondControl = vi.fn(async () => undefined);
    const client = {
      projectSessions: { open, respondControl },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      root.sessionRegistry.load("parent", projectPath);
      root.sessionLayoutStore.ensureSession("parent");
      root.appShellStore.selectProjectSession("parent");
      root.projectWorkbenchStore.showLoadedSession("parent");

      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "parent",
        controlRequestId: "00000000-0000-4000-8000-000000000000",
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: "background-child",
          title: "Background child",
          familyId: "family",
          familyChildOrder: 0,
          placement: "none",
        },
      });
      expect(root.sessionCatalogStore.find("background-child")).toMatchObject({
        title: "Background child",
        pending: true,
      });
      expect(root.sessionLayoutStore.panes.map((pane) => pane.sessionId)).toEqual(["parent"]);
      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "parent",
      });

      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "parent",
        controlRequestId: "00000000-0000-4000-8000-000000000001",
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: "child-1",
          title: "First child",
          familyId: "family",
          familyChildOrder: 0,
          placement: "right",
        },
      });
      const childPaneId = root.sessionLayoutStore.paneForSession("child-1")?.paneId;
      expect(root.sessionCatalogStore.find("child-1")).toMatchObject({
        title: "First child",
        pending: true,
        familyParentSessionId: "parent",
      });
      expect(root.sessionLayoutStore.panes).toHaveLength(2);
      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "child-1",
      });

      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "parent",
        controlRequestId: "00000000-0000-4000-8000-000000000002",
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: "child-2",
          title: "Second child",
          familyId: "family",
          familyChildOrder: 1,
          placement: "right",
        },
      });
      expect(root.sessionLayoutStore.paneForSession("child-2")?.paneId).toBe(childPaneId);
      expect(root.sessionLayoutStore.hasSession("child-1")).toBe(false);
      expect(root.sessionLayoutStore.panes).toHaveLength(2);
      expect(open).toHaveBeenCalledTimes(3);
      expect(respondControl).toHaveBeenCalledTimes(3);
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("forks the calling project session with an optional prompt and title", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("source", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const fork = vi.fn(async () => ({ sessionId: "forked" }));
    const rename = vi.fn(async () => undefined);
    const prompt = vi.fn(async () => "turn-1");
    const respondControl = vi.fn(async () => undefined);
    const client = {
      projectSessions: { fork, prompt, rename, respondControl },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "source",
        controlRequestId: "00000000-0000-4000-8000-000000000003",
        invocation: {
          _tag: "ForkSession",
          entryId: "entry-1",
          prompt: "Continue in the fork.",
          title: "Forked work",
          resolveSource: true,
          placement: "none",
        },
      });

      expect(fork).toHaveBeenCalledWith(
        {
          sessionId: "source",
          workingDirectory: projectPath,
          entryId: "entry-1",
          resolveSource: true,
          destinationWorkingDirectory: projectPath,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(rename).toHaveBeenCalledWith(
        { sessionId: "forked", workingDirectory: projectPath, name: "Forked work" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(prompt).toHaveBeenCalledWith(
        {
          sessionId: "forked",
          workingDirectory: projectPath,
          text: "Continue in the fork.",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(respondControl).toHaveBeenCalledWith(
        "source",
        "00000000-0000-4000-8000-000000000003",
        {
          ok: true,
          sessionId: "forked",
          placement: "none",
          sourceResolved: true,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("routes independent session creation through a new managed worktree when requested", async () => {
    const models = RootProjection.create();
    const parentWorktreePath = "/projects/.cake-worktrees/parent-task";
    applySnapshot(models.projects, {
      projects: [
        {
          path: projectPath,
          name: "Example",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("source-session", parentWorktreePath)],
      resolvedHasMoreByProject: {},
    });
    const managedWorktree = {
      projectPath,
      worktreePath,
      branch: "agent/example-task",
      baseBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const createWorktree = vi.fn(async () => managedWorktree);
    const start = vi.fn(async () => undefined);
    const controlResults: unknown[] = [];
    const respondControl = vi.fn(
      async (_sessionId: string, _controlRequestId: string, result: unknown) => {
        controlResults.push(result);
      },
    );
    const client = {
      managedWorktrees: { create: createWorktree },
      projectSessions: { start, respondControl },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);
    const model = {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high" as const,
      fastMode: true,
    };

    try {
      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "source-session",
        controlRequestId: "00000000-0000-4000-8000-000000000003",
        invocation: {
          _tag: "CreateSession",
          name: "Investigate rendering",
          initialPrompt: "Investigate the renderer and implement the focused fix.",
          worktreeName: "example-task",
          model,
        },
      });

      expect(createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          path: projectPath,
          worktreeName: "example-task",
        }),
      );
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: worktreePath,
          name: "Investigate rendering",
          text: "Investigate the renderer and implement the focused fix.",
          configuration: model,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const managedResult = controlResults[0];
      expect(managedResult).toMatchObject({
        ok: true,
        name: "create_session",
        workspacePath: worktreePath,
        status: "started",
        managedWorktree,
      });
      if (!managedResult || typeof managedResult !== "object" || !("sessionId" in managedResult))
        throw new Error("Expected the created session identity");
      const createdSessionId = String(managedResult.sessionId);
      expect(root.sessionRegistry.findSession(createdSessionId)?.workspacePath).toBe(worktreePath);
      const createdSummary = root.sessionCatalogStore.find(createdSessionId);
      expect(createdSummary).toMatchObject({
        sessionId: createdSessionId,
        projectPath,
        workingDirectory: worktreePath,
      });
      expect(createdSummary).not.toHaveProperty("familyId");
      expect(createdSummary).not.toHaveProperty("familyParentSessionId");

      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "source-session",
        controlRequestId: "00000000-0000-4000-8000-000000000004",
        invocation: {
          _tag: "CreateSession",
          name: "Project-root follow-up",
          initialPrompt: "Continue the project-root investigation.",
          model,
        },
      });

      expect(createWorktree).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workingDirectory: projectPath,
          name: "Project-root follow-up",
          text: "Continue the project-root investigation.",
          configuration: model,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(controlResults[1]).toMatchObject({
        ok: true,
        workspacePath: projectPath,
        status: "started",
      });
      expect(controlResults[1]).not.toHaveProperty("managedWorktree");
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("does not start a session at the Project root when managed worktree creation fails", async () => {
    const models = RootProjection.create();
    applySnapshot(models.projects, {
      projects: [
        {
          path: projectPath,
          name: "Example",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("source-session", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const start = vi.fn(async () => undefined);
    const responses: Array<{
      sessionId: string;
      controlRequestId: string;
      result: unknown;
      options: unknown;
    }> = [];
    const respondControl = vi.fn(
      async (sessionId: string, controlRequestId: string, result: unknown, options: unknown) => {
        responses.push({ sessionId, controlRequestId, result, options });
      },
    );
    const client = {
      managedWorktrees: {
        create: vi.fn(async () => {
          throw new Error("managed checkout setup failed");
        }),
      },
      projectSessions: { start, respondControl },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "source-session",
        controlRequestId: "00000000-0000-4000-8000-000000000005",
        invocation: {
          _tag: "CreateSession",
          name: "Isolated investigation",
          initialPrompt: "Investigate in isolation.",
          worktreeName: "isolated-investigation",
          model: {
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "high",
            fastMode: false,
          },
        },
      });

      expect(start).not.toHaveBeenCalled();
      expect(responses).toEqual([
        {
          sessionId: "source-session",
          controlRequestId: "00000000-0000-4000-8000-000000000005",
          result: expect.objectContaining({
            ok: false,
            name: "sessions.create",
            error: "managed checkout setup failed",
          }),
          options: expect.objectContaining({ signal: expect.any(AbortSignal) }),
        },
      ]);
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("does not replace a session selected while worktree resolution is in flight", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [
        sessionSummary("worktree-session", worktreePath),
        sessionSummary("current-session", projectPath),
      ],
      resolvedHasMoreByProject: {},
    });
    const resolution = deferred<{
      projectPath: string;
      workingDirectory: string;
      resolvedSessionIds: string[];
      failures: [];
    }>();
    const client = {
      projectSessions: { resolveWorkingDirectory: vi.fn(() => resolution.promise) },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);
    const createSession = vi.spyOn(root, "createSession").mockResolvedValue(undefined);

    try {
      root.appShellStore.selectProjectSession("worktree-session");
      const resolving = root.projectWorkbenchStore.resolveWorktreeWorkspace(worktreePath, {
        initiatingSessionId: "worktree-session",
        workingDirectoryRetired: true,
      });
      root.appShellStore.selectProjectSession("current-session");

      resolution.resolve({
        projectPath,
        workingDirectory: worktreePath,
        resolvedSessionIds: ["worktree-session"],
        failures: [],
      });
      await resolving;

      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "current-session",
      });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });
});
