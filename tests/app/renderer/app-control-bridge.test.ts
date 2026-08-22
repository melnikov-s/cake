import { describe, expect, it, vi } from "vitest";
import { observable } from "r-state-tree";
import { jsonValueSchema } from "../../../src/ipc/json-contract";
import type { GlobalSessionSummary, ProjectRecord } from "../../../src/ipc/session-contract";
import type { CustomizationState, PluginStatus } from "../../../src/plugin/plugin-contract";
import {
  AppControlBridge,
  appControlToolCatalog,
  type AppControlHost,
} from "../../../src/renderer/app-control-bridge";

const projects: ProjectRecord[] = [
  {
    path: "/cake",
    name: "Cake",
    addedAt: "2026-08-01T00:00:00.000Z",
    lastOpenedAt: "2026-08-12T00:00:00.000Z",
  },
  {
    path: "/pie",
    name: "Pie",
    addedAt: "2026-08-02T00:00:00.000Z",
    lastOpenedAt: "2026-08-11T00:00:00.000Z",
  },
];

const sessions: GlobalSessionSummary[] = [
  {
    id: "older",
    title: "Older work",
    created: "2026-08-01T00:00:00.000Z",
    modified: "2026-08-10T00:00:00.000Z",
    messageCount: 4,
    resolved: false,
    workspacePath: "/pie",
    workspaceName: "Pie",
  },
  {
    id: "current",
    title: "Current work",
    created: "2026-08-02T00:00:00.000Z",
    modified: "2026-08-12T00:00:00.000Z",
    messageCount: 8,
    resolved: false,
    workspacePath: "/cake",
    workspaceName: "Cake",
  },
  {
    id: "running",
    title: "Background work",
    created: "2026-08-03T00:00:00.000Z",
    modified: "2026-08-11T00:00:00.000Z",
    messageCount: 2,
    resolved: false,
    workspacePath: "/cake",
    workspaceName: "Cake",
  },
];
const cakeChatSessions = [
  {
    id: "cake-chat-current",
    title: "Cake-wide work",
    created: "2026-08-04T00:00:00.000Z",
    modified: "2026-08-13T00:00:00.000Z",
    messageCount: 6,
    resolved: false,
  },
  {
    id: "cake-chat-resolved",
    title: "Finished Cake work",
    created: "2026-08-01T00:00:00.000Z",
    modified: "2026-08-09T00:00:00.000Z",
    messageCount: 3,
    resolved: true,
  },
];

function createBridge(
  customization: Partial<
    Pick<
      AppControlHost,
      "currentSession" | "customizationState" | "plugins" | "setPluginEnabled" | "setActiveScene"
    >
  > = {},
) {
  const openSession = vi.fn(async () => undefined);
  const createSession = vi.fn(async () => undefined);
  const sendSessionMessage = vi.fn(async () => undefined);
  const abortSession = vi.fn(async () => undefined);
  const renameSession = vi.fn(async () => undefined);
  const setSessionResolved = vi.fn(async () => undefined);
  const setSessionsResolved = vi.fn(async () => 2);
  const setCakeChatSessionsResolved = vi.fn(async () => 1);
  const setSessionModel = vi.fn(async () => undefined);
  const bridge = new AppControlBridge({
    currentSession:
      customization.currentSession ?? (() => ({ workspacePath: "/cake", sessionId: "current" })),
    projects: () => projects,
    sessions: () => sessions,
    cakeChatSessions: () => cakeChatSessions,
    sessionActivity: (sessionId) => (sessionId === "running" ? "running" : undefined),
    openSession,
    createSession,
    sendSessionMessage,
    abortSession,
    renameSession,
    setSessionResolved,
    setSessionsResolved,
    setCakeChatSessionsResolved,
    setSessionModel,
    customizationState: customization.customizationState ?? (() => undefined),
    plugins: customization.plugins ?? (() => []),
    getPluginAuthoringReference: vi.fn(async () => "reference"),
    listPluginFiles: vi.fn(async () => ({
      workingRevision: "a".repeat(64),
      buildRevision: "a".repeat(64),
      files: [],
    })),
    createPlugin: vi.fn(async () => ({
      workingRevision: "b".repeat(64),
      buildRevision: "b".repeat(64),
      files: [],
    })),
    readPluginFile: vi.fn(async () => "source"),
    writePluginFile: vi.fn(async () => ({
      workingRevision: "b".repeat(64),
      buildRevision: "b".repeat(64),
      files: [],
    })),
    validateCustomization: vi.fn(async () => ({
      revision: "a".repeat(64),
      sourceRevision: "a".repeat(64),
      diagnostics: [],
      valid: true,
    })),
    activateCustomization: vi.fn(async () => ({
      revision: "a".repeat(64),
      activating: true as const,
    })),
    rollbackCustomization: vi.fn(async () => ({
      schemaVersion: 1 as const,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date(0).toISOString(),
    })),
    useFactoryCustomization: vi.fn(async () => ({
      schemaVersion: 1 as const,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date(0).toISOString(),
    })),
    setPluginEnabled: customization.setPluginEnabled ?? vi.fn(async () => []),
    setActiveScene: customization.setActiveScene ?? vi.fn(async () => []),
  });
  return {
    bridge,
    openSession,
    createSession,
    sendSessionMessage,
    abortSession,
    renameSession,
    setSessionResolved,
    setSessionsResolved,
    setCakeChatSessionsResolved,
    setSessionModel,
  };
}

describe("AppControlBridge", () => {
  it("publishes the curated tool catalog", () => {
    expect(appControlToolCatalog.map((tool) => tool.name)).toEqual([
      "get_app_state",
      "get_customization_state",
      "get_plugin_authoring_reference",
      "list_plugin_files",
      "create_plugin",
      "read_plugin_file",
      "write_plugin_file",
      "validate_customization",
      "activate_customization",
      "rollback_customization",
      "use_factory_customization",
      "set_plugin_enabled",
      "set_active_scene",
      "get_session_status",
      "open_session",
      "create_session",
      "send_session_message",
      "abort_session",
      "rename_session",
      "set_session_resolved",
      "set_sessions_resolved",
      "set_cake_chat_sessions_resolved",
      "set_session_model",
    ]);
  });

  it("resolves global Cake Chat sessions", async () => {
    const { bridge, setCakeChatSessionsResolved } = createBridge();

    await expect(
      bridge.invoke({
        name: "set_cake_chat_sessions_resolved",
        arguments: { sessionIds: ["cake-chat-current"], resolved: true },
      }),
    ).resolves.toEqual({
      ok: true,
      name: "set_cake_chat_sessions_resolved",
      sessionIds: ["cake-chat-current"],
      resolved: true,
      sessionCount: 1,
    });
    expect(setCakeChatSessionsResolved).toHaveBeenCalledWith(["cake-chat-current"], true);
    await expect(
      bridge.invoke({
        name: "set_cake_chat_sessions_resolved",
        arguments: { sessionIds: ["missing"], resolved: true },
      }),
    ).resolves.toEqual({
      ok: false,
      name: "set_cake_chat_sessions_resolved",
      error: "Cake could not find Cake Chat session missing.",
    });
  });

  it("returns compact live application state", async () => {
    const { bridge } = createBridge();

    const result = await bridge.invoke({ name: "get_app_state", arguments: {} });

    expect(result).toMatchObject({
      ok: true,
      name: "get_app_state",
      state: {
        currentSession: { workspacePath: "/cake", sessionId: "current" },
        projectCount: 2,
        sessionCount: 3,
        projects: [
          { path: "/cake", name: "Cake", sessionCount: 2 },
          { path: "/pie", name: "Pie", sessionCount: 1 },
        ],
        attentionSessions: [{ sessionId: "running", activity: "running" }],
        recentSessions: [
          { sessionId: "current" },
          { sessionId: "running" },
          { sessionId: "older" },
        ],
      },
    });
  });

  it("omits unavailable optional state instead of returning undefined JSON properties", async () => {
    const { bridge } = createBridge({
      currentSession: () => undefined,
      customizationState: () => undefined,
      plugins: () => [],
    });

    const appState = await bridge.invoke({ name: "get_app_state", arguments: {} });
    const customizationState = await bridge.invoke({
      name: "get_customization_state",
      arguments: {},
    });

    expect(appState).not.toHaveProperty("state.currentSession");
    expect(customizationState).not.toHaveProperty("state");
    expect(jsonValueSchema.safeParse(appState).success).toBe(true);
    expect(jsonValueSchema.safeParse(customizationState).success).toBe(true);
  });

  it("returns cloneable customization snapshots from observable Store data", async () => {
    const state = observable<CustomizationState>({
      schemaVersion: 1,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date(0).toISOString(),
    });
    const plugins = observable<PluginStatus[]>([
      {
        id: "example.widget",
        name: "Example Widget",
        enabled: true,
        renderer: "index.tsx",
        activeScene: false,
        diagnostics: [],
      },
    ]);
    const { bridge } = createBridge({ customizationState: () => state, plugins: () => plugins });

    const result = await bridge.invoke({ name: "get_customization_state", arguments: {} });

    expect(() => structuredClone(result)).not.toThrow();
    expect(result).toEqual({ ok: true, name: "get_customization_state", state, plugins });
    if (!result.ok || result.name !== "get_customization_state")
      throw new Error("Expected customization state");
    expect(result.state).not.toBe(state);
    expect(result.plugins).not.toBe(plugins);
  });

  it("returns strict JSON after changing plugin enablement", async () => {
    const plugin: PluginStatus = {
      id: "user.environment",
      name: "Environment",
      enabled: false,
      renderer: "renderer.tsx",
      backend: undefined,
      scene: undefined,
      activeScene: false,
      diagnostics: [],
    };
    const { bridge } = createBridge({ setPluginEnabled: vi.fn(async () => [plugin]) });

    const result = await bridge.invoke({
      name: "set_plugin_enabled",
      arguments: { pluginId: plugin.id, enabled: false },
    });

    expect(jsonValueSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      ok: true,
      name: "set_plugin_enabled",
      plugins: [
        {
          id: plugin.id,
          name: plugin.name,
          enabled: false,
          renderer: "renderer.tsx",
          activeScene: false,
          diagnostics: [],
        },
      ],
    });
  });

  it("opens only a session from the live Cake catalog", async () => {
    const { bridge, openSession } = createBridge();

    await expect(
      bridge.invoke({ name: "open_session", arguments: { sessionId: "current" } }),
    ).resolves.toEqual({
      ok: true,
      name: "open_session",
      opened: { workspacePath: "/cake", sessionId: "current" },
    });
    expect(openSession).toHaveBeenCalledWith("current");

    await expect(
      bridge.invoke({ name: "open_session", arguments: { sessionId: "missing" } }),
    ).resolves.toEqual({
      ok: false,
      name: "open_session",
      error: "Cake could not find that session.",
    });
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("reports live session status", async () => {
    const { bridge } = createBridge();

    await expect(
      bridge.invoke({ name: "get_session_status", arguments: { sessionId: "current" } }),
    ).resolves.toMatchObject({ ok: true, selected: true, status: "idle" });
    await expect(
      bridge.invoke({ name: "get_session_status", arguments: { sessionId: "running" } }),
    ).resolves.toMatchObject({ ok: true, selected: false, status: "running" });
  });

  it("sends to idle and running sessions with an appropriate default delivery", async () => {
    const { bridge, sendSessionMessage } = createBridge();

    await expect(
      bridge.invoke({
        name: "send_session_message",
        arguments: { sessionId: "current", text: "Commit the work" },
      }),
    ).resolves.toMatchObject({ ok: true, delivery: "prompt", status: "sent" });
    await expect(
      bridge.invoke({
        name: "send_session_message",
        arguments: { sessionId: "running", text: "Also update the tests" },
      }),
    ).resolves.toMatchObject({ ok: true, delivery: "follow-up", status: "sent" });

    expect(sendSessionMessage).toHaveBeenNthCalledWith(1, "current", "Commit the work", "prompt");
    expect(sendSessionMessage).toHaveBeenNthCalledWith(
      2,
      "running",
      "Also update the tests",
      "follow-up",
    );
  });

  it("refuses to abort an idle session", async () => {
    const { bridge, abortSession } = createBridge();

    await expect(
      bridge.invoke({ name: "abort_session", arguments: { sessionId: "current" } }),
    ).resolves.toEqual({
      ok: false,
      name: "abort_session",
      error: "That session is not currently running.",
    });
    await expect(
      bridge.invoke({ name: "abort_session", arguments: { sessionId: "running" } }),
    ).resolves.toMatchObject({ ok: true, status: "stopping" });
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("creates and organizes sessions only through known targets", async () => {
    const {
      bridge,
      createSession,
      renameSession,
      setSessionResolved,
      setSessionsResolved,
      setSessionModel,
    } = createBridge();

    await expect(
      bridge.invoke({ name: "create_session", arguments: { workspacePath: "/cake" } }),
    ).resolves.toEqual({
      ok: true,
      name: "create_session",
      workspacePath: "/cake",
      status: "creating",
    });
    await expect(
      bridge.invoke({ name: "create_session", arguments: { workspacePath: "/missing" } }),
    ).resolves.toEqual({
      ok: false,
      name: "create_session",
      error: "Cake could not find that project.",
    });
    await bridge.invoke({
      name: "rename_session",
      arguments: { sessionId: "current", title: "Global controls" },
    });
    await bridge.invoke({
      name: "set_session_resolved",
      arguments: { sessionId: "current", resolved: true },
    });
    await expect(
      bridge.invoke({
        name: "set_sessions_resolved",
        arguments: { sessionIds: ["current", "running"], resolved: false },
      }),
    ).resolves.toEqual({
      ok: true,
      name: "set_sessions_resolved",
      sessionIds: ["current", "running"],
      resolved: false,
      sessionCount: 2,
    });
    await expect(
      bridge.invoke({
        name: "set_sessions_resolved",
        arguments: { sessionIds: ["missing"], resolved: true },
      }),
    ).resolves.toEqual({
      ok: false,
      name: "set_sessions_resolved",
      error: "Cake could not find session missing.",
    });
    await bridge.invoke({
      name: "set_session_model",
      arguments: { sessionId: "current", provider: "openai", modelId: "gpt-5" },
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(renameSession).toHaveBeenCalledWith("current", "Global controls");
    expect(setSessionResolved).toHaveBeenCalledWith("current", true);
    expect(setSessionsResolved).toHaveBeenCalledWith(["current", "running"], false);
    expect(setSessionModel).toHaveBeenCalledWith("current", "openai", "gpt-5");
  });
});
