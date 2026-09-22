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
  it("keeps the current session selected while a new session is prepared", async () => {
    const models = RootProjection.create();
    const client = {} as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);
    const preparation = deferred();
    vi.spyOn(root.projectWorkbenchStore, "startNewSession").mockReturnValue(preparation.promise);

    try {
      root.appShellStore.selectProjectSession("current-session");

      const creating = root.createSession("/projects/another");

      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "current-session",
      });

      preparation.resolve();
      await creating;
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

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
          familyDepth: 1,
          workingDirectory: projectPath,
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
          familyDepth: 1,
          workingDirectory: projectPath,
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
          familyDepth: 1,
          workingDirectory: projectPath,
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

  it("switches a background session to VS Code without stealing pane focus", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("focused", projectPath), sessionSummary("background", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const respondControl = vi.fn(async () => undefined);
    const client = { projectSessions: { respondControl } } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      root.sessionRegistry.load("focused", projectPath);
      root.sessionRegistry.load("background", projectPath);
      root.sessionLayoutStore.ensureSession("focused");
      root.appShellStore.selectProjectSession("focused");
      root.projectWorkbenchStore.showLoadedSession("focused");

      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "background",
        controlRequestId: "00000000-0000-4000-8000-000000000020",
        invocation: {
          _tag: "InvokeAppControl",
          command: "vscode.enter",
          input: {},
        },
      });

      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "focused",
      });
      expect(root.sessionLayoutStore.focusedSessionId).toBe("focused");
      expect(root.sessionRegistry.findSession("background")?.presentationMode).toBe("vscode");
      expect(respondControl).toHaveBeenCalledWith(
        "background",
        "00000000-0000-4000-8000-000000000020",
        expect.objectContaining({ ok: true, command: "vscode.enter" }),
        expect.anything(),
      );
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("does not navigate to a background session for a Draw control", async () => {
    const models = RootProjection.create();
    const root = mountRootStore(
      {} as Client,
      { state: {}, children: {} },
      async () => undefined,
      models,
    );
    const invoke = vi.fn(async () => ({
      ok: false as const,
      code: "BOARD_NOT_OPEN" as const,
      message: "No whiteboard is open.",
    }));

    try {
      root.appShellStore.selectProjectSession("focused");
      root.sessionLayoutStore.ensureSession("focused");
      root.drawControlStore.register({ sessionId: "background", invoke });

      await root.drawControlStore.invoke("background", { _tag: "Enter" });

      expect(invoke).toHaveBeenCalledOnce();
      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "focused",
      });
      expect(root.sessionLayoutStore.focusedSessionId).toBe("focused");
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("routes agent worktree merge and discard controls through the managed queue client", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("child", worktreePath)],
      resolvedHasMoreByProject: {},
    });
    const startLanding = vi.fn(async (input: { operationId: string }) => ({
      operationId: input.operationId,
      workspacePath: worktreePath,
      sessionId: "child",
      kind: "landing" as const,
      phase: "waiting" as const,
      allowDirtyTarget: false,
    }));
    const discard = vi.fn(async () => undefined);
    const respondControl = vi.fn(async () => undefined);
    const client = {
      managedWorktrees: { startLanding, discard },
      projectSessions: { respondControl },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "child",
        controlRequestId: "00000000-0000-4000-8000-000000000010",
        invocation: {
          _tag: "InvokeAppControl",
          command: "worktrees.merge",
          input: { sessionId: "child", workingDirectory: worktreePath },
        },
      });
      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "child",
        controlRequestId: "00000000-0000-4000-8000-000000000011",
        invocation: {
          _tag: "InvokeAppControl",
          command: "worktrees.discard",
          input: { sessionId: "child", workingDirectory: worktreePath, keepBranch: true },
        },
      });

      expect(startLanding).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: worktreePath,
          sessionId: "child",
          strategy: "preserve",
          commitBeforeLanding: true,
          resolveAfterLanding: false,
        }),
        expect.anything(),
      );
      expect(discard).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: worktreePath, keepBranch: true }),
        expect.anything(),
      );
      expect(respondControl).toHaveBeenCalledTimes(2);
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
    const open = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const prompt = vi.fn(async () => "turn-1");
    const respondControl = vi.fn(async () => undefined);
    const client = {
      projectSessions: { fork, open, rename, respondControl },
      sessionChats: { prompt },
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
      expect(open).toHaveBeenCalledWith(
        { sessionId: "forked", workingDirectory: projectPath },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(open.mock.invocationCallOrder[0]).toBeLessThan(
        prompt.mock.invocationCallOrder[0] ?? 0,
      );
      expect(rename).toHaveBeenCalledWith(
        { sessionId: "forked", workingDirectory: projectPath, name: "Forked work" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(prompt).toHaveBeenCalledWith(
        {
          sessionId: "forked",
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

  it("removes a fork registration when its runtime cannot be opened", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("source", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const prompt = vi.fn(async () => "turn-1");
    const respondControl = vi.fn(async () => undefined);
    const client = {
      projectSessions: {
        fork: vi.fn(async () => ({ sessionId: "failed-fork" })),
        open: vi.fn(async () => {
          throw new Error("runtime failed to open");
        }),
        respondControl,
      },
      sessionChats: { prompt },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "source",
        controlRequestId: "00000000-0000-4000-8000-000000000006",
        invocation: {
          _tag: "ForkSession",
          entryId: "entry-1",
          prompt: "This must not be sent.",
          resolveSource: false,
          placement: "none",
        },
      });

      expect(root.sessionRegistry.findSession("failed-fork")).toBeUndefined();
      expect(prompt).not.toHaveBeenCalled();
      expect(respondControl).toHaveBeenCalledWith(
        "source",
        "00000000-0000-4000-8000-000000000006",
        expect.objectContaining({ ok: false, error: "runtime failed to open" }),
        expect.anything(),
      );
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("removes a projected family child when opening its runtime fails", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("parent", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const respondControl = vi.fn(async () => undefined);
    const client = {
      projectSessions: {
        open: vi.fn(async () => {
          throw new Error("child runtime failed");
        }),
        respondControl,
      },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      await root.applicationControlStore.handleProjectSessionRequest({
        sessionId: "parent",
        controlRequestId: "00000000-0000-4000-8000-000000000007",
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: "failed-child",
          title: "Failed child",
          familyId: "family",
          familyChildOrder: 0,
          familyDepth: 1,
          workingDirectory: projectPath,
          placement: "none",
        },
      });

      expect(root.sessionRegistry.findSession("failed-child")).toBeUndefined();
      expect(root.sessionCatalogStore.find("failed-child")).toBeUndefined();
      expect(respondControl).toHaveBeenCalledWith(
        "parent",
        "00000000-0000-4000-8000-000000000007",
        expect.objectContaining({ ok: false, error: "child runtime failed" }),
        expect.anything(),
      );
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("retires resolved Project Session renderer ownership and creates a project fallback", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("active", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const resolve = vi.fn(async () => undefined);
    const client = { projectSessions: { resolve } } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);
    const createSession = vi.spyOn(root, "createSession").mockResolvedValue(undefined);

    try {
      root.sessionRegistry.load("active", projectPath);
      root.sessionLayoutStore.ensureSession("active");
      root.appShellStore.selectProjectSession("active");

      await root.sessionRetirementStore.setProjectSessionResolved("active", true);

      expect(resolve).toHaveBeenCalledWith(
        { sessionId: "active", workingDirectory: projectPath },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(root.sessionRegistry.findSession("active")).toBeUndefined();
      expect(root.sessionLayoutStore.hasSession("active")).toBe(false);
      expect(createSession).toHaveBeenCalledWith(projectPath);
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
        command: "sessions.create",
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
            command: "sessions.create",
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

  it("cleans Project navigation and loaded sessions after delete-on-remove succeeds", async () => {
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
      sessions: [sessionSummary("removed-session", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const removeProject = vi.fn(async () => ({ projects: [] }));
    const client = { workspaces: { removeProject } } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      root.sessionRegistry.load("removed-session", projectPath);
      root.sessionLayoutStore.ensureSession("removed-session");
      root.appShellStore.selectProjectSession("removed-session");

      await expect(root.projectRemovalStore.remove(projectPath, true)).resolves.toBe(true);

      expect(removeProject).toHaveBeenCalledWith(
        projectPath,
        true,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(root.sessionRegistry.findSession("removed-session")).toBeUndefined();
      expect(root.appShellStore.selection).toEqual({ kind: "workbench" });
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
