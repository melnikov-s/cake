import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CakeChatTarget } from "../../../src/domain/cake-chat-data";
import {
  AppControlBridge,
  type AppControlHost,
  listAppControlTools,
} from "../../../src/renderer/app-control-bridge";

describe("AppControlBridge", () => {
  it("constructs a Cake Chat RPC target without explicit undefined optional fields", () => {
    const target = {
      sessionId: "9f0de1b1-4baa-4706-9a41-1b9e3c90b404",
      tools: listAppControlTools(),
    };

    expect(() => Schema.decodeUnknownSync(CakeChatTarget)(target)).not.toThrow();
    expect(
      target.tools
        .filter((tool) => tool.topic !== "customizations")
        .every((tool) => !("guidance" in tool)),
    ).toBe(true);
  });

  it("includes the managed worktree associated with each listed session", async () => {
    const managedWorktree = {
      projectPath: "/projects/cake",
      worktreePath: "/projects/.cake-worktrees/session-worktree",
      branch: "agent/session-worktree",
      baseBranch: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
    };
    const host: AppControlHost = {
      currentSession: () => undefined,
      projects: () => [],
      sessions: () => [
        {
          workingDirectory: managedWorktree.worktreePath,
          projectName: "Cake",
          sessionId: "session-1",
          title: "Worktree session",
          modifiedAt: "2026-03-01T13:00:00.000Z",
          messageCount: 3,
          resolved: false,
          managedWorktree,
        },
      ],
      cakeChatSessions: () => [],
      sessionActivity: () => undefined,
      openSession: async () => false,
      createSession: async () => {
        throw new Error("not used");
      },
      sendSessionMessage: async () => undefined,
      abortSession: async () => undefined,
      renameSession: async () => undefined,
      setSessionResolved: async () => undefined,
      setSessionsResolved: async () => 0,
      setCakeChatSessionsResolved: async () => 0,
      setSessionModel: async () => undefined,
      customizationState: () => undefined,
      plugins: () => [],
      getPluginAuthoringReference: async () => "",
      listPluginFiles: async () => ({ workingRevision: "", buildRevision: "", files: [] }),
      createPlugin: async () => {
        throw new Error("not used");
      },
      readPluginFile: async () => "",
      writePluginFile: async () => ({ workingRevision: "", buildRevision: "", files: [] }),
      validateCustomization: async () => {
        throw new Error("not used");
      },
      activateCustomization: async () => {
        throw new Error("not used");
      },
      rollbackCustomization: async () => {
        throw new Error("not used");
      },
      useFactoryCustomization: async () => {
        throw new Error("not used");
      },
      setPluginEnabled: async () => [],
      setActiveScene: async () => [],
    };

    await expect(
      new AppControlBridge(host).invoke({ name: "sessions.list", arguments: {} }),
    ).resolves.toMatchObject({
      sessions: [{ sessionId: "session-1", managedWorktree }],
    });
  });
});
