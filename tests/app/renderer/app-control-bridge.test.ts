import { Schema } from "effect";
import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { CakeChatTarget } from "../../../src/domain/cake-chats/cake-chat-data";
import {
  AppControlBridge,
  type AppControlHost,
  listAppControlTools,
} from "../../../src/renderer/app-control/AppControlBridge";
import { Message } from "../../../src/renderer/models/Message";
import { Session } from "../../../src/renderer/models/Session";
import { SessionCoordinationStore } from "../../../src/renderer/stores/SessionCoordinationStore";

type AppControlHostOverrides = Partial<
  AppControlHost["state"] & AppControlHost["sessions"] & AppControlHost["presentation"]
> & {
  sessionCoordination?: AppControlHost["sessionCoordination"];
  settings?: AppControlHost["settings"];
};

function createHost(overrides: AppControlHostOverrides = {}): AppControlHost {
  return {
    sessionCoordination:
      overrides.sessionCoordination ??
      mount(createStore(SessionCoordinationStore, { sessionById: () => undefined })),
    state: {
      currentSelection: overrides.currentSelection ?? (() => ({ kind: "workbench" })),
      projects: overrides.projects ?? (() => []),
      sessions: overrides.sessions ?? (() => []),
      cakeChatSessions: overrides.cakeChatSessions ?? (() => []),
      sessionActivity: overrides.sessionActivity ?? (() => undefined),
      managedWorktree: overrides.managedWorktree ?? (() => undefined),
      ...(overrides.sessionLayout ? { sessionLayout: overrides.sessionLayout } : null),
    },
    settings:
      overrides.settings ??
      ({
        get: () => ({
          section: "appearance",
          settings: {
            theme: "system",
            projectAvatarsEnabled: true,
            sessionAvatarsEnabled: true,
            workLogViewMode: "auto",
            workLogsExpansion: "collapsed",
          },
        }),
        update: async () => ({
          section: "appearance",
          settings: {
            theme: "system",
            projectAvatarsEnabled: true,
            sessionAvatarsEnabled: true,
            workLogViewMode: "auto",
            workLogsExpansion: "collapsed",
          },
        }),
      } satisfies AppControlHost["settings"]),
    sessions: {
      open: overrides.open ?? (async () => false),
      create:
        overrides.create ??
        (async () => {
          throw new Error("not used");
        }),
      createDraft:
        overrides.createDraft ??
        (async () => {
          throw new Error("not used");
        }),
      sendMessage: overrides.sendMessage ?? (async () => "turn-1"),
      compact: overrides.compact ?? (async () => undefined),
      scheduleMessage:
        overrides.scheduleMessage ??
        (async () => {
          throw new Error("not used");
        }),
      listScheduledMessages: overrides.listScheduledMessages ?? (async () => []),
      cancelScheduledMessage: overrides.cancelScheduledMessage ?? (async () => undefined),
      listPendingMessages:
        overrides.listPendingMessages ?? (async () => ({ steering: [], followUp: [] })),
      dequeuePendingMessages:
        overrides.dequeuePendingMessages ?? (async () => ({ steering: [], followUp: [] })),
      abort: overrides.abort ?? (async () => undefined),
      rename: overrides.rename ?? (async () => undefined),
      setProjectSessionsResolved: overrides.setProjectSessionsResolved ?? (async () => 0),
      setCakeChatSessionsResolved: overrides.setCakeChatSessionsResolved ?? (async () => 0),
    },
    presentation: {
      splitView: overrides.splitView ?? (() => undefined),
      showNotification: overrides.showNotification ?? (async () => undefined),
      showAgentAction: overrides.showAgentAction ?? (() => undefined),
    },
  };
}

describe("AppControlBridge", () => {
  it("constructs a Cake Chat RPC target without explicit undefined optional fields", () => {
    const target = {
      sessionId: "9f0de1b1-4baa-4706-9a41-1b9e3c90b404",
      tools: listAppControlTools(),
    };

    expect(() => Schema.decodeUnknownSync(CakeChatTarget)(target)).not.toThrow();
    expect(target.tools.some((tool) => tool.command === "app.split")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "sessions.create-draft")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "notifications.send")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "settings.sections")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "settings.get")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "settings.update")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "sessions.rename")).toBe(true);
    const create = target.tools.find((tool) => tool.command === "sessions.create");
    expect(create && "guidance" in create ? create.guidance : undefined).toContainEqual(
      expect.stringContaining("inherits"),
    );
    expect(create?.examples?.[0]?.input).toMatchObject({ model: "Sol" });
    const parameters = JSON.stringify(create?.parameters);
    expect(parameters).toContain('"type":"string"');
    expect(parameters).toContain('"provider"');
    expect(parameters).toContain('"modelId"');
    expect(parameters).toContain('"thinkingLevel"');
    expect(parameters).toContain('"fastMode"');
  });

  it("describes the live pane layout relative to the calling project session", async () => {
    const sessionLayout = vi.fn((source?: { sessionId: string }) => ({
      focusedSessionId: "session-b",
      originSessionId: source?.sessionId,
      panes: [
        {
          paneId: "pane-a",
          sessionId: "session-a",
          number: 1,
          focused: false,
          x: 0,
          y: 0,
          width: 0.5,
          height: 1,
        },
        {
          paneId: "pane-b",
          sessionId: "session-b",
          number: 2,
          focused: true,
          x: 0.5,
          y: 0,
          width: 0.5,
          height: 1,
        },
      ],
    }));
    const bridge = new AppControlBridge(createHost({ sessionLayout }));

    await expect(
      bridge.invoke(
        { name: "app.state", arguments: {} },
        { kind: "project-session", sessionId: "session-a", title: "Origin" },
      ),
    ).resolves.toMatchObject({
      state: {
        sessionLayout: {
          focusedSessionId: "session-b",
          originSessionId: "session-a",
          panes: [
            { sessionId: "session-a", x: 0, width: 0.5 },
            { sessionId: "session-b", x: 0.5, width: 0.5 },
          ],
        },
      },
    });
    expect(sessionLayout).toHaveBeenCalledWith({
      kind: "project-session",
      sessionId: "session-a",
      title: "Origin",
    });
  });

  it("splits the calling Cake Chat pane through the application control", async () => {
    const splitView = vi.fn(() => ({
      kind: "cake-chat" as const,
      paneId: "pane-new",
      sessionId: "chat-new",
    }));
    const bridge = new AppControlBridge(createHost({ splitView }));
    const source = { kind: "cake-chat" as const, sessionId: "chat-a", title: "Cake Chat" };

    await expect(
      bridge.invoke({ name: "app.split", arguments: { direction: "right" } }, source),
    ).resolves.toMatchObject({
      ok: true,
      command: "app.split",
      direction: "right",
      kind: "cake-chat",
      paneId: "pane-new",
      sessionId: "chat-new",
    });
    expect(splitView).toHaveBeenCalledWith(source, "right");
  });

  it("reports the complete current Cake selection", async () => {
    const bridge = new AppControlBridge(
      createHost({
        currentSelection: () => ({
          kind: "cake-chat",
          sessionId: "cake-chat-1",
          title: "Release planning",
        }),
      }),
    );

    await expect(bridge.invoke({ name: "app.state", arguments: {} })).resolves.toMatchObject({
      state: {
        selection: {
          kind: "cake-chat",
          sessionId: "cake-chat-1",
          title: "Release planning",
        },
      },
    });
  });

  it("lists, reads, and updates Cake settings through the invoking window", async () => {
    const get = vi.fn(() => ({
      section: "appearance" as const,
      settings: {
        theme: "system" as const,
        projectAvatarsEnabled: true,
        sessionAvatarsEnabled: true,
        workLogViewMode: "auto" as const,
        workLogsExpansion: "collapsed" as const,
      },
    }));
    const update = vi.fn(async () => ({
      section: "appearance" as const,
      settings: {
        theme: "dark" as const,
        projectAvatarsEnabled: true,
        sessionAvatarsEnabled: true,
        workLogViewMode: "auto" as const,
        workLogsExpansion: "collapsed" as const,
      },
    }));
    const bridge = new AppControlBridge(createHost({ settings: { get, update } }));

    await expect(
      bridge.invoke({ name: "settings.sections", arguments: {} }),
    ).resolves.toMatchObject({
      ok: true,
      command: "settings.sections",
      sections: [
        { id: "appearance", scope: "window", writable: true },
        { id: "editor", scope: "window", writable: true },
        { id: "hotkeys", scope: "window", writable: true },
      ],
    });
    await expect(
      bridge.invoke({ name: "settings.get", arguments: { section: "appearance" } }),
    ).resolves.toMatchObject({
      ok: true,
      command: "settings.get",
      scope: "window",
      section: "appearance",
      settings: { theme: "system" },
    });
    await expect(
      bridge.invoke({
        name: "settings.update",
        arguments: { section: "appearance", changes: { theme: "dark" } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "settings.update",
      scope: "window",
      section: "appearance",
      settings: { theme: "dark" },
    });
    expect(get).toHaveBeenCalledWith("appearance");
    expect(update).toHaveBeenCalledWith({ section: "appearance", changes: { theme: "dark" } });

    await expect(
      bridge.invoke({
        name: "settings.update",
        arguments: { section: "appearance", changes: {} },
      }),
    ).rejects.toThrow();
    await expect(
      bridge.invoke({
        name: "settings.update",
        arguments: { section: "editor", changes: { sidebarAutoHideWidth: 900 } },
      }),
    ).rejects.toThrow();
  });

  it("routes attributed notifications through the application host without a receipt", async () => {
    const showNotification = vi.fn(async () => undefined);
    const showAgentAction = vi.fn();
    const source = {
      kind: "project-session" as const,
      sessionId: "source-1",
      title: "Build monitor",
    };
    const bridge = new AppControlBridge(createHost({ showNotification, showAgentAction }));

    await expect(
      bridge.invoke(
        {
          name: "notifications.send",
          arguments: { title: "Build progress", body: "Tests reached 80%." },
        },
        source,
      ),
    ).resolves.toEqual({ ok: true, command: "notifications.send", status: "queued" });
    expect(showNotification).toHaveBeenCalledWith({
      title: "Build progress",
      body: "Tests reached 80%.",
      level: "info",
      source,
    });
    expect(showAgentAction).not.toHaveBeenCalled();
  });

  it("coalesces equivalent calling-session resolution receipts", async () => {
    const showAgentAction = vi.fn();
    const source = {
      kind: "project-session" as const,
      sessionId: "session-1",
      title: "Build monitor",
    };
    const bridge = new AppControlBridge(
      createHost({
        showAgentAction,
        sessions: () => [
          {
            workingDirectory: "/projects/cake",
            projectName: "Cake",
            sessionId: "session-1",
            title: "Build monitor",
            modifiedAt: "2026-03-01T12:00:00.000Z",
            messageCount: 3,
            resolved: false,
            draft: false,
          },
        ],
        setProjectSessionsResolved: async () => 1,
      }),
    );

    await bridge.invoke({ name: "agent.action", arguments: { action: "resolve" } }, source);
    await bridge.invoke(
      {
        name: "sessions.resolve",
        arguments: {
          targets: [{ kind: "project", sessionId: "session-1" }],
          resolved: true,
        },
      },
      source,
    );

    expect(showAgentAction).toHaveBeenCalledTimes(2);
    expect(showAgentAction.mock.calls[0]![0].coalesceKey).toBe(
      showAgentAction.mock.calls[1]![0].coalesceKey,
    );
  });

  it("turns completed calling-session actions into attributed receipts", async () => {
    const showAgentAction = vi.fn();
    const source = {
      kind: "cake-chat" as const,
      sessionId: "source-1",
      title: "Release planning",
    };
    const bridge = new AppControlBridge(createHost({ showAgentAction }));

    await expect(
      bridge.invoke(
        {
          name: "agent.action",
          arguments: { action: "set-model", detail: "openai/gpt-5" },
        },
        source,
      ),
    ).resolves.toEqual({
      ok: true,
      command: "agent.action",
      action: "set-model",
      detail: "openai/gpt-5",
    });
    expect(showAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        message: "Changed this session’s model to openai/gpt-5",
        targetSessionId: "source-1",
        targetKind: "cake-chat",
      }),
    );
  });

  it("creates and starts a session with an exact model configuration in a managed worktree", async () => {
    const managedWorktree = {
      projectPath: "/projects/cake",
      worktreePath: "/projects/.cake-worktrees/implementation-session",
      branch: "agent/implementation-session",
      baseBranch: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
    };
    const createSession = vi.fn(async () => ({
      workspacePath: managedWorktree.worktreePath,
      sessionId: "session-new",
      managedWorktree,
    }));
    const bridge = new AppControlBridge(
      createHost({
        projects: () => [
          {
            path: "/projects/cake",
            name: "Cake",
            addedAt: "2026-03-01T12:00:00.000Z",
            lastOpenedAt: "2026-03-01T12:00:00.000Z",
          },
        ],
        create: createSession,
      }),
    );
    const model = {
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "high" as const,
      fastMode: true,
    };

    await expect(
      bridge.invoke({
        name: "sessions.create",
        arguments: {
          workspacePath: "/projects/cake",
          name: "Implementation session",
          initialPrompt: "Implement the approved changes",
          model,
          worktreeName: "implementation-session",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      command: "sessions.create",
      workspacePath: managedWorktree.worktreePath,
      sessionId: "session-new",
      title: "Implementation session",
      status: "started",
      managedWorktree,
    });
    expect(createSession).toHaveBeenCalledWith({
      workspacePath: "/projects/cake",
      name: "Implementation session",
      initialPrompt: "Implement the approved changes",
      model,
      worktreeName: "implementation-session",
    });
  });

  it("rejects invalid managed worktree names before session creation", async () => {
    const createSession = vi.fn(async () => ({
      workspacePath: "/projects/cake",
      sessionId: "session-new",
    }));
    const bridge = new AppControlBridge(
      createHost({
        projects: () => [
          {
            path: "/projects/cake",
            name: "Cake",
            addedAt: "2026-03-01T12:00:00.000Z",
            lastOpenedAt: "2026-03-01T12:00:00.000Z",
          },
        ],
        create: createSession,
      }),
    );

    await expect(
      bridge.invoke({
        name: "sessions.create",
        arguments: {
          workspacePath: "/projects/cake",
          name: "Implementation session",
          initialPrompt: "Implement the approved changes",
          worktreeName: "Invalid Worktree",
        },
      }),
    ).rejects.toThrow();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates a saved draft without starting a Pi session", async () => {
    const createDraftSession = vi.fn(async () => ({
      workspacePath: "/projects/cake",
      sessionId: "draft-1",
    }));
    const showAgentAction = vi.fn();
    const bridge = new AppControlBridge(
      createHost({
        showAgentAction,
        projects: () => [
          {
            path: "/projects/cake",
            name: "Cake",
            addedAt: "2026-03-01T12:00:00.000Z",
            lastOpenedAt: "2026-03-01T12:00:00.000Z",
          },
        ],
        createDraft: createDraftSession,
      }),
    );

    await expect(
      bridge.invoke(
        {
          name: "sessions.create-draft",
          arguments: {
            workspacePath: "/projects/cake",
            name: "Draft session",
            initialPrompt: "Implement this later",
          },
        },
        { kind: "project-session", sessionId: "source-1", title: "Source session" },
      ),
    ).resolves.toEqual({
      ok: true,
      command: "sessions.create-draft",
      workspacePath: "/projects/cake",
      sessionId: "draft-1",
      title: "Draft session",
      status: "saved-draft",
    });
    expect(createDraftSession).toHaveBeenCalledWith({
      workspacePath: "/projects/cake",
      name: "Draft session",
      initialPrompt: "Implement this later",
    });
    expect(showAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "project-session", sessionId: "source-1", title: "Source session" },
        message: "Created draft “Draft session”",
        targetSessionId: "draft-1",
      }),
    );
  });

  it("compacts and schedules messages for sessions in another project", async () => {
    const sendSessionMessage = vi.fn(async () => "turn-1");
    const compactSession = vi.fn(async () => undefined);
    const scheduleSessionMessage = vi.fn(async (input) => ({
      id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
      ...input,
      createdAt: "2026-09-04T12:00:00.000Z",
    }));
    const host = createHost({
      sessions: () => [
        {
          workingDirectory: "/projects/other",
          projectName: "Other",
          sessionId: "session-2",
          title: "Other project session",
          modifiedAt: "2026-09-04T12:00:00.000Z",
          messageCount: 2,
          resolved: false,
          draft: false,
        },
      ],
      sendMessage: sendSessionMessage,
      compact: compactSession,
      scheduleMessage: scheduleSessionMessage,
    });
    const bridge = new AppControlBridge(host);

    await expect(
      bridge.invoke({
        name: "sessions.send",
        arguments: { sessionId: "session-2", text: "Queue this", delivery: "queue" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "sessions.send",
      delivery: "queue",
      status: "queued",
      targetTitle: "Other project session",
      messageId: "turn-1",
    });
    await expect(
      bridge.invoke({
        name: "sessions.compact",
        arguments: { sessionId: "session-2", instructions: "Keep decisions" },
      }),
    ).resolves.toMatchObject({ ok: true, command: "sessions.compact", status: "compacted" });
    await expect(
      bridge.invoke({
        name: "sessions.schedule",
        arguments: {
          sessionId: "session-2",
          text: "Review this",
          sendAt: "2030-01-01T12:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "sessions.schedule",
      status: "scheduled",
      scheduledMessage: { targetSessionId: "session-2", text: "Review this" },
    });
    expect(sendSessionMessage).toHaveBeenCalledWith("session-2", "Queue this", "follow-up");
    expect(compactSession).toHaveBeenCalledWith("session-2", "Keep decisions");
    expect(scheduleSessionMessage).toHaveBeenCalledWith({
      targetSessionId: "session-2",
      text: "Review this",
      sendAt: "2030-01-01T12:00:00.000Z",
    });
  });

  it("steers and stops an active explicitly targeted session", async () => {
    const sendSessionMessage = vi.fn(async () => "turn-1");
    const abortSession = vi.fn(async () => undefined);
    const bridge = new AppControlBridge(
      createHost({
        sessions: () => [
          {
            workingDirectory: "/projects/other",
            projectName: "Other",
            sessionId: "session-2",
            title: "Active child",
            modifiedAt: "2026-09-04T12:00:00.000Z",
            messageCount: 2,
            resolved: false,
            draft: false,
          },
        ],
        sessionActivity: () => "running",
        sendMessage: sendSessionMessage,
        abort: abortSession,
      }),
    );

    await expect(
      bridge.invoke({
        name: "sessions.send",
        arguments: { sessionId: "session-2", text: "Change direction", delivery: "steer" },
      }),
    ).resolves.toMatchObject({ ok: true, delivery: "steer", status: "accepted" });
    await expect(
      bridge.invoke({ name: "sessions.abort", arguments: { sessionId: "session-2" } }),
    ).resolves.toMatchObject({ ok: true, command: "sessions.abort", status: "stopping" });
    expect(sendSessionMessage).toHaveBeenCalledWith("session-2", "Change direction", "steer");
    expect(abortSession).toHaveBeenCalledWith("session-2");
  });

  it("renames an explicitly targeted session and reports the committed title", async () => {
    const renameSession = vi.fn(async () => undefined);
    const showAgentAction = vi.fn();
    const bridge = new AppControlBridge(
      createHost({
        sessions: () => [
          {
            workingDirectory: "/projects/other",
            projectName: "Other",
            sessionId: "session-2",
            title: "Untitled child",
            modifiedAt: "2026-09-04T12:00:00.000Z",
            messageCount: 2,
            resolved: false,
            draft: false,
          },
        ],
        rename: renameSession,
        showAgentAction,
      }),
    );
    const source = {
      kind: "project-session" as const,
      sessionId: "session-1",
      title: "Parent",
    };

    await expect(
      bridge.invoke(
        {
          name: "sessions.rename",
          arguments: { sessionId: "session-2", title: "  Storage implementation  " },
        },
        source,
      ),
    ).resolves.toMatchObject({
      ok: true,
      command: "sessions.rename",
      target: { workspacePath: "/projects/other", sessionId: "session-2" },
      title: "Storage implementation",
    });
    expect(renameSession).toHaveBeenCalledWith("session-2", "Storage implementation");
    expect(showAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        targetSessionId: "session-2",
        targetKind: "project-session",
        message: "Renamed session to “Storage implementation”",
      }),
    );

    await expect(
      bridge.invoke({
        name: "sessions.rename",
        arguments: { sessionId: "missing", title: "Nope" },
      }),
    ).resolves.toMatchObject({ ok: false, command: "sessions.rename" });
    await expect(
      bridge.invoke({
        name: "sessions.rename",
        arguments: { sessionId: "session-2", title: "  " },
      }),
    ).rejects.toThrow();
    expect(renameSession).toHaveBeenCalledTimes(1);
  });

  it("keeps duplicate-title targets disambiguated by project and working directory", async () => {
    const sessions = [
      {
        workingDirectory: "/projects/alpha",
        projectName: "Alpha",
        sessionId: "session-a",
        title: "Review",
        modifiedAt: "2026-03-02T13:00:00.000Z",
        messageCount: 3,
        resolved: false,
        draft: false,
      },
      {
        workingDirectory: "/projects/beta/.worktrees/review",
        projectName: "Beta",
        sessionId: "session-b",
        title: "Review",
        modifiedAt: "2026-03-01T13:00:00.000Z",
        messageCount: 7,
        resolved: false,
        draft: false,
      },
    ];
    const bridge = new AppControlBridge(createHost({ sessions: () => sessions }));

    await expect(bridge.invoke({ name: "sessions.list", arguments: {} })).resolves.toMatchObject({
      sessions: [
        { sessionId: "session-a", workspaceName: "Alpha", workspacePath: "/projects/alpha" },
        {
          sessionId: "session-b",
          workspaceName: "Beta",
          workspacePath: "/projects/beta/.worktrees/review",
        },
      ],
    });
  });

  it("attaches sender metadata and routes replies through the thread binding", async () => {
    const sendSessionMessage = vi
      .fn()
      .mockResolvedValueOnce("turn-b")
      .mockResolvedValueOnce("turn-a");
    const showAgentAction = vi.fn();
    const sessions = [
      {
        workingDirectory: "/projects/alpha",
        projectName: "Alpha",
        sessionId: "session-a",
        title: "Review",
        modifiedAt: "2026-03-02T13:00:00.000Z",
        messageCount: 3,
        resolved: false,
        draft: false,
      },
      {
        workingDirectory: "/projects/beta",
        projectName: "Beta",
        sessionId: "session-b",
        title: "Review",
        modifiedAt: "2026-03-01T13:00:00.000Z",
        messageCount: 7,
        resolved: false,
        draft: false,
      },
    ];
    const bridge = new AppControlBridge(
      createHost({
        sessions: () => sessions,
        sendMessage: sendSessionMessage,
        showAgentAction,
      }),
    );
    const sourceA = {
      kind: "project-session" as const,
      sessionId: "session-a",
      title: "Review",
      projectName: "Alpha",
      workingDirectory: "/projects/alpha",
    };
    const first = await bridge.invoke(
      {
        name: "sessions.send",
        arguments: { sessionId: "session-b", text: "First", maxMessages: 3 },
      },
      sourceA,
    );
    expect(first).toMatchObject({
      status: "accepted",
      targetTitle: "Review",
      messageNumber: 1,
      maxMessages: 3,
    });
    const threadId = (first as { threadId: string }).threadId;
    expect(sendSessionMessage).toHaveBeenNthCalledWith(
      1,
      "session-b",
      "First",
      "prompt",
      expect.objectContaining({
        threadId,
        sequence: 1,
        sender: {
          kind: "project-session",
          sessionId: "session-a",
          title: "Review",
          projectName: "Alpha",
          workingDirectory: "/projects/alpha",
        },
      }),
    );

    await expect(
      bridge.invoke(
        { name: "sessions.reply", arguments: { text: "Second" } },
        {
          kind: "project-session",
          sessionId: "session-b",
          title: "Review",
          projectName: "Beta",
          workingDirectory: "/projects/beta",
        },
      ),
    ).resolves.toMatchObject({ target: { sessionId: "session-a" }, messageNumber: 2, threadId });
    expect(sendSessionMessage).toHaveBeenNthCalledWith(
      2,
      "session-a",
      "Second",
      "prompt",
      expect.objectContaining({ threadId, sequence: 2 }),
    );
    expect(showAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Accepted message 2/3") }),
    );
  });

  it("tracks queued acknowledgements, enforces the limit, and rejects late continuation", async () => {
    const sendSessionMessage = vi.fn(async () => "turn-b");
    const targetSession = Session.create({ sessionId: "session-b" });
    const sessionCoordination = mount(
      createStore(SessionCoordinationStore, {
        sessionById: (sessionId) => (sessionId === "session-b" ? targetSession : undefined),
      }),
    );
    const bridge = new AppControlBridge(
      createHost({
        sessionCoordination,
        sessions: () => [
          {
            workingDirectory: "/a",
            projectName: "A",
            sessionId: "session-a",
            title: "A",
            modifiedAt: "2026-03-02T13:00:00.000Z",
            messageCount: 1,
            resolved: false,
            draft: false,
          },
          {
            workingDirectory: "/b",
            projectName: "B",
            sessionId: "session-b",
            title: "B",
            modifiedAt: "2026-03-01T13:00:00.000Z",
            messageCount: 1,
            resolved: false,
            draft: false,
          },
        ],
        sessionActivity: (sessionId) => (sessionId === "session-b" ? "waiting" : undefined),
        sendMessage: sendSessionMessage,
      }),
    );
    const source = { kind: "project-session" as const, sessionId: "session-a", title: "A" };
    const sent = await bridge.invoke(
      {
        name: "sessions.send",
        arguments: { sessionId: "session-b", text: "Only message", maxMessages: 1 },
      },
      source,
    );
    expect(sent).toMatchObject({ status: "queued", delivery: "queue", messageNumber: 1 });
    expect(sendSessionMessage).toHaveBeenCalledWith(
      "session-b",
      "Only message",
      "follow-up",
      expect.any(Object),
    );
    const sentMessageId = (sent as { messageId: string }).messageId;
    const sentThreadId = (sent as { threadId: string }).threadId;
    targetSession.parts.push(
      Message.create({
        id: "projected-message",
        partKey: "projected-message",
        kind: "text",
        role: "user",
        text: "Only message",
        status: "complete",
        crossSession: {
          version: 1,
          messageId: sentMessageId,
          threadId: sentThreadId,
          sequence: 1,
          maxMessages: 1,
          sender: { kind: "project-session", sessionId: "session-a", title: "A" },
        },
      }),
    );
    targetSession.activeTurnIds.push("turn-b");
    await expect(
      bridge.invoke({ name: "sessions.thread", arguments: {} }, source),
    ).resolves.toMatchObject({
      thread: { state: "closed", messageCount: 1, messages: [{ status: "processing" }] },
    });
    await expect(
      bridge.invoke({ name: "sessions.reply", arguments: { text: "Too late" } }, source),
    ).resolves.toMatchObject({ ok: false, error: "That session thread is closed." });
  });

  it("lists and dequeues another session's pending messages in bulk", async () => {
    const messages = { steering: ["Change direction"], followUp: ["Do this next"] };
    const listPendingMessages = vi.fn(async () => messages);
    const dequeuePendingMessages = vi.fn(async () => messages);
    const bridge = new AppControlBridge(
      createHost({
        sessions: () => [
          {
            workingDirectory: "/projects/cake",
            projectName: "Cake",
            sessionId: "session-1",
            title: "Session",
            modifiedAt: "2026-09-04T12:00:00.000Z",
            messageCount: 1,
            resolved: false,
            draft: false,
          },
        ],
        listPendingMessages,
        dequeuePendingMessages,
      }),
    );

    await expect(
      bridge.invoke({ name: "sessions.pending", arguments: { sessionId: "session-1" } }),
    ).resolves.toMatchObject({ ok: true, messages });
    await expect(
      bridge.invoke({ name: "sessions.dequeue", arguments: { sessionId: "session-1" } }),
    ).resolves.toMatchObject({ ok: true, messages });

    expect(listPendingMessages).toHaveBeenCalledWith("session-1");
    expect(dequeuePendingMessages).toHaveBeenCalledWith("session-1");
  });

  it("includes the managed worktree associated with each listed session", async () => {
    const managedWorktree = {
      projectPath: "/projects/cake",
      worktreePath: "/projects/.cake-worktrees/session-worktree",
      branch: "agent/session-worktree",
      baseBranch: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
    };
    const host = createHost({
      sessions: () => [
        {
          workingDirectory: managedWorktree.worktreePath,
          projectName: "Cake",
          sessionId: "session-1",
          title: "Worktree session",
          modifiedAt: "2026-03-01T13:00:00.000Z",
          messageCount: 3,
          resolved: false,
          draft: false,
        },
      ],
      managedWorktree: (workingDirectory) =>
        workingDirectory === managedWorktree.worktreePath ? managedWorktree : undefined,
    });

    await expect(
      new AppControlBridge(host).invoke({ name: "sessions.list", arguments: {} }),
    ).resolves.toMatchObject({
      sessions: [{ sessionId: "session-1", draft: false, managedWorktree }],
    });
  });
});
