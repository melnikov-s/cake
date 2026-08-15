import { describe, expect, it, vi } from "vitest";
import type { GlobalSessionSummary, ProjectRecord } from "../../../src/ipc/session-contract";
import { AppControlBridge, appControlToolCatalog } from "../../../src/renderer/app-control-bridge";

const projects: ProjectRecord[] = [
  { path: "/cake", name: "Cake", addedAt: "2026-08-01T00:00:00.000Z", lastOpenedAt: "2026-08-12T00:00:00.000Z", archivedSessionIds: [] },
  { path: "/pie", name: "Pie", addedAt: "2026-08-02T00:00:00.000Z", lastOpenedAt: "2026-08-11T00:00:00.000Z", archivedSessionIds: [] }
];

const sessions: GlobalSessionSummary[] = [
  { id: "older", title: "Older work", created: "2026-08-01T00:00:00.000Z", modified: "2026-08-10T00:00:00.000Z", messageCount: 4, archived: false, workspacePath: "/pie", workspaceName: "Pie" },
  { id: "current", title: "Current work", created: "2026-08-02T00:00:00.000Z", modified: "2026-08-12T00:00:00.000Z", messageCount: 8, archived: false, workspacePath: "/cake", workspaceName: "Cake" },
  { id: "running", title: "Background work", created: "2026-08-03T00:00:00.000Z", modified: "2026-08-11T00:00:00.000Z", messageCount: 2, archived: false, workspacePath: "/cake", workspaceName: "Cake" }
];

function createBridge() {
  const openSession = vi.fn(async () => undefined);
  const createSession = vi.fn(async () => undefined);
  const sendSessionMessage = vi.fn(async () => undefined);
  const abortSession = vi.fn(async () => undefined);
  const renameSession = vi.fn(async () => undefined);
  const setSessionArchived = vi.fn(async () => undefined);
  const setSessionModel = vi.fn(async () => undefined);
  const readSession = vi.fn(async () => [
    { id: "user-1", kind: "text" as const, role: "user" as const, entryId: "entry-1", text: "Find the PDF session", status: "complete" as const },
    { id: "tool-1", kind: "tool" as const, name: "search", input: "PDF", output: "Found it", state: "success" as const },
    { id: "assistant-1", kind: "text" as const, role: "assistant" as const, entryId: "entry-2", text: "Here it is", status: "complete" as const }
  ]);
  const bridge = new AppControlBridge({
    currentSession: () => ({ workspacePath: "/cake", sessionId: "current" }),
    projects: () => projects,
    sessions: () => sessions,
    sessionActivity: (_workspacePath, sessionId) => sessionId === "running" ? "running" : undefined,
    readSession,
    openSession,
    createSession,
    sendSessionMessage,
    abortSession,
    renameSession,
    setSessionArchived,
    setSessionModel,
    customizationState: () => undefined,
    plugins: () => [],
    listCustomizationFiles: vi.fn(async () => ({ workingRevision: "a".repeat(64), buildRevision: "a".repeat(64), files: [] })),
    readCustomizationFile: vi.fn(async () => "source"),
    writeCustomizationFile: vi.fn(async () => ({ workingRevision: "b".repeat(64), buildRevision: "b".repeat(64), files: [] })),
    buildCustomization: vi.fn(async () => ({ revision: "a".repeat(64), diagnostics: [], activating: true })),
    rollbackCustomization: vi.fn(async () => ({ schemaVersion: 1 as const, recoveryRequired: false, diagnostics: [], updatedAt: new Date(0).toISOString() })),
    useFactoryCustomization: vi.fn(async () => ({ schemaVersion: 1 as const, recoveryRequired: false, diagnostics: [], updatedAt: new Date(0).toISOString() })),
    setPluginEnabled: vi.fn(async () => [])
  });
  return { bridge, openSession, readSession, createSession, sendSessionMessage, abortSession, renameSession, setSessionArchived, setSessionModel };
}

describe("AppControlBridge", () => {
  it("publishes the curated tool catalog", () => {
    expect(appControlToolCatalog.map((tool) => tool.name)).toEqual([
      "get_app_state",
      "get_customization_state",
      "list_customization_files",
      "read_customization_file",
      "write_customization_file",
      "build_customization",
      "rollback_customization",
      "use_factory_customization",
      "set_plugin_enabled",
      "get_session_status",
      "open_session",
      "list_sessions",
      "read_session",
      "search_sessions",
      "create_session",
      "send_session_message",
      "abort_session",
      "rename_session",
      "set_session_archived",
      "set_session_model"
    ]);
  });

  it("lists sessions with filtering and pagination", async () => {
    const { bridge } = createBridge();

    await expect(bridge.invoke({ name: "list_sessions", arguments: { workspacePath: "/cake", limit: 1 } }))
      .resolves.toMatchObject({
        ok: true,
        name: "list_sessions",
        total: 2,
        nextCursor: 1,
        sessions: [{ sessionId: "current", workspacePath: "/cake" }]
      });
  });

  it("reads a session without opening it", async () => {
    const { bridge, openSession, readSession } = createBridge();

    await expect(bridge.invoke({ name: "read_session", arguments: { workspacePath: "/cake", sessionId: "current", limit: 2 } }))
      .resolves.toMatchObject({
        ok: true,
        name: "read_session",
        totalParts: 3,
        nextCursor: 2,
        parts: [
          { index: 0, id: "user-1", entryId: "entry-1", role: "user", text: "Find the PDF session" },
          { index: 1, id: "tool-1", text: "Tool: search\nPDF\nFound it" }
        ]
      });
    expect(readSession).toHaveBeenCalledWith("/cake", "current");
    expect(openSession).not.toHaveBeenCalled();
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
          { path: "/pie", name: "Pie", sessionCount: 1 }
        ],
        attentionSessions: [{ sessionId: "running", activity: "running" }],
        recentSessions: [
          { sessionId: "current" },
          { sessionId: "running" },
          { sessionId: "older" }
        ]
      }
    });
  });

  it("opens only a session from the live Cake catalog", async () => {
    const { bridge, openSession } = createBridge();

    await expect(bridge.invoke({ name: "open_session", arguments: { workspacePath: "/cake", sessionId: "current" } }))
      .resolves.toEqual({ ok: true, name: "open_session", opened: { workspacePath: "/cake", sessionId: "current" } });
    expect(openSession).toHaveBeenCalledWith("/cake", "current");

    await expect(bridge.invoke({ name: "open_session", arguments: { workspacePath: "/cake", sessionId: "missing" } }))
      .resolves.toEqual({ ok: false, name: "open_session", error: "Cake could not find that session." });
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("searches titles and transcript content without opening sessions", async () => {
    const { bridge, openSession, readSession } = createBridge();

    await expect(bridge.invoke({ name: "search_sessions", arguments: { query: "PDF", workspacePath: "/cake", limit: 5 } }))
      .resolves.toMatchObject({
        ok: true,
        name: "search_sessions",
        query: "PDF",
        searchedSessions: 2,
        results: [
          { session: { sessionId: "current" }, matches: [
            { location: "transcript", partIndex: 0, snippet: "Find the PDF session" },
            { location: "transcript", partIndex: 1, snippet: "Tool: search\nPDF\nFound it" }
          ] },
          { session: { sessionId: "running" }, matches: [
            { location: "transcript", partIndex: 0, snippet: "Find the PDF session" },
            { location: "transcript", partIndex: 1, snippet: "Tool: search\nPDF\nFound it" }
          ] }
        ]
      });
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("reports live session status", async () => {
    const { bridge } = createBridge();

    await expect(bridge.invoke({ name: "get_session_status", arguments: { workspacePath: "/cake", sessionId: "current" } }))
      .resolves.toMatchObject({ ok: true, selected: true, status: "idle" });
    await expect(bridge.invoke({ name: "get_session_status", arguments: { workspacePath: "/cake", sessionId: "running" } }))
      .resolves.toMatchObject({ ok: true, selected: false, status: "running" });
  });

  it("sends to idle and running sessions with an appropriate default delivery", async () => {
    const { bridge, sendSessionMessage } = createBridge();

    await expect(bridge.invoke({ name: "send_session_message", arguments: { workspacePath: "/cake", sessionId: "current", text: "Commit the work" } }))
      .resolves.toMatchObject({ ok: true, delivery: "prompt", status: "sent" });
    await expect(bridge.invoke({ name: "send_session_message", arguments: { workspacePath: "/cake", sessionId: "running", text: "Also update the tests" } }))
      .resolves.toMatchObject({ ok: true, delivery: "follow-up", status: "sent" });

    expect(sendSessionMessage).toHaveBeenNthCalledWith(1, "/cake", "current", "Commit the work", "prompt");
    expect(sendSessionMessage).toHaveBeenNthCalledWith(2, "/cake", "running", "Also update the tests", "follow-up");
  });

  it("refuses to abort an idle session", async () => {
    const { bridge, abortSession } = createBridge();

    await expect(bridge.invoke({ name: "abort_session", arguments: { workspacePath: "/cake", sessionId: "current" } }))
      .resolves.toEqual({ ok: false, name: "abort_session", error: "That session is not currently running." });
    await expect(bridge.invoke({ name: "abort_session", arguments: { workspacePath: "/cake", sessionId: "running" } }))
      .resolves.toMatchObject({ ok: true, status: "stopping" });
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("creates and organizes sessions only through known targets", async () => {
    const { bridge, createSession, renameSession, setSessionArchived, setSessionModel } = createBridge();

    await expect(bridge.invoke({ name: "create_session", arguments: { workspacePath: "/cake" } }))
      .resolves.toEqual({ ok: true, name: "create_session", workspacePath: "/cake", status: "creating" });
    await expect(bridge.invoke({ name: "create_session", arguments: { workspacePath: "/missing" } }))
      .resolves.toEqual({ ok: false, name: "create_session", error: "Cake could not find that project." });
    await bridge.invoke({ name: "rename_session", arguments: { workspacePath: "/cake", sessionId: "current", title: "Global controls" } });
    await bridge.invoke({ name: "set_session_archived", arguments: { workspacePath: "/cake", sessionId: "current", archived: true } });
    await bridge.invoke({ name: "set_session_model", arguments: { workspacePath: "/cake", sessionId: "current", provider: "openai", modelId: "gpt-5" } });

    expect(createSession).toHaveBeenCalledOnce();
    expect(renameSession).toHaveBeenCalledWith("/cake", "current", "Global controls");
    expect(setSessionArchived).toHaveBeenCalledWith("/cake", "current", true);
    expect(setSessionModel).toHaveBeenCalledWith("/cake", "current", "openai", "gpt-5");
  });
});
