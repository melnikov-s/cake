import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CakeChatTarget } from "../../../src/domain/cake-chat-data";
import {
  AppControlBridge,
  type AppControlHost,
  listAppControlTools,
} from "../../../src/renderer/app-control-bridge";

function createHost(overrides: Partial<AppControlHost> = {}): AppControlHost {
  return {
    currentSession: () => undefined,
    projects: () => [],
    sessions: () => [],
    cakeChatSessions: () => [],
    sessionActivity: () => undefined,
    openSession: async () => false,
    createSession: async () => {
      throw new Error("not used");
    },
    createDraftSession: async () => {
      throw new Error("not used");
    },
    sendSessionMessage: async () => undefined,
    compactSession: async () => undefined,
    scheduleSessionMessage: async () => {
      throw new Error("not used");
    },
    listScheduledMessages: async () => [],
    cancelScheduledMessage: async () => undefined,
    abortSession: async () => undefined,
    renameSession: async () => undefined,
    setSessionResolved: async () => undefined,
    setSessionsResolved: async () => 0,
    setCakeChatSessionsResolved: async () => 0,
    setSessionModel: async () => undefined,
    ...overrides,
  };
}

describe("AppControlBridge", () => {
  it("constructs a Cake Chat RPC target without explicit undefined optional fields", () => {
    const target = {
      sessionId: "9f0de1b1-4baa-4706-9a41-1b9e3c90b404",
      tools: listAppControlTools(),
    };

    expect(() => Schema.decodeUnknownSync(CakeChatTarget)(target)).not.toThrow();
    expect(target.tools.some((tool) => tool.command === "sessions.create-draft")).toBe(true);
    expect(target.tools.every((tool) => !("guidance" in tool))).toBe(true);
  });

  it("describes the live pane layout relative to the calling project session", async () => {
    const sessionLayout = vi.fn((originSessionId?: string) => ({
      focusedSessionId: "session-b",
      originSessionId,
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
      bridge.invoke({ name: "app.state", arguments: {} }, "session-a"),
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
    expect(sessionLayout).toHaveBeenCalledWith("session-a");
  });

  it("creates a saved draft without starting a Pi session", async () => {
    const createDraftSession = vi.fn(async () => ({
      workspacePath: "/projects/cake",
      sessionId: "draft-1",
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
        createDraftSession,
      }),
    );

    await expect(
      bridge.invoke({
        name: "sessions.create-draft",
        arguments: {
          workspacePath: "/projects/cake",
          name: "Draft session",
          initialPrompt: "Implement this later",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      name: "create_draft_session",
      workspacePath: "/projects/cake",
      sessionId: "draft-1",
      status: "saved-draft",
    });
    expect(createDraftSession).toHaveBeenCalledWith({
      workspacePath: "/projects/cake",
      name: "Draft session",
      initialPrompt: "Implement this later",
    });
  });

  it("compacts and schedules messages for sessions in another project", async () => {
    const sendSessionMessage = vi.fn(async () => undefined);
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
      sendSessionMessage,
      compactSession,
      scheduleSessionMessage,
    });
    const bridge = new AppControlBridge(host);

    await expect(
      bridge.invoke({
        name: "sessions.send",
        arguments: { sessionId: "session-2", text: "Queue this", delivery: "queue" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      name: "send_session_message",
      delivery: "queue",
      status: "sent",
    });
    await expect(
      bridge.invoke({
        name: "sessions.compact",
        arguments: { sessionId: "session-2", instructions: "Keep decisions" },
      }),
    ).resolves.toMatchObject({ ok: true, name: "compact_session", status: "compacted" });
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
      name: "schedule_session_message",
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
          managedWorktree,
        },
      ],
    });

    await expect(
      new AppControlBridge(host).invoke({ name: "sessions.list", arguments: {} }),
    ).resolves.toMatchObject({
      sessions: [{ sessionId: "session-1", draft: false, managedWorktree }],
    });
  });
});
