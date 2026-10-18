import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CakeChatTarget } from "../../../src/contracts/cake-chats/cake-chat-data";
import type { VscodeEditorAction } from "../../../src/contracts/vscode/vscode-editor-action";

import {
  AppControlBridge,
  listAppControlTools,
  listSessionAssistantControlTools,
} from "../../../src/renderer/app-control/AppControlBridge";
import type {
  AgentControlSource,
  AppControlHost,
  AppControlResult,
} from "../../../src/renderer/app-control/app-control-data";
import { AppControlRegistry } from "../../../src/renderer/app-control/app-control-registry";
import {
  defineControl,
  type ControlContext,
} from "../../../src/renderer/app-control/control-definition";

type AppControlHostOverrides = Partial<
  AppControlHost["state"] & AppControlHost["sessions"] & AppControlHost["presentation"]
> & {
  settings?: AppControlHost["settings"];
  vscode?: Partial<AppControlHost["vscode"]>;
  worktrees?: AppControlHost["worktrees"];
  projectRegistry?: AppControlHost["projects"];
};

function createHost(overrides: AppControlHostOverrides = {}): AppControlHost {
  return {
    state: {
      currentSelection: overrides.currentSelection ?? (() => ({ kind: "workbench" })),
      userSelection: overrides.userSelection ?? (() => null),
      projects: overrides.projects ?? (() => []),
      sessions: overrides.sessions ?? (() => []),
      cakeChatSessions: overrides.cakeChatSessions ?? (() => []),
      sessionActivity: overrides.sessionActivity ?? (() => undefined),
      managedWorktree: overrides.managedWorktree ?? (() => undefined),
      globalSessionLabels: overrides.globalSessionLabels ?? (() => []),
      ...(overrides.sessionLayout ? { sessionLayout: overrides.sessionLayout } : null),
    },
    agentSettings: { invoke: async () => null },
    settings:
      overrides.settings ??
      ({
        get: () => ({
          section: "appearance",
          settings: {
            theme: "system",
            projectAvatarsEnabled: true,
            sessionAvatarsEnabled: true,
            sidebarCharactersEnabled: false,
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
            sidebarCharactersEnabled: false,
            workLogViewMode: "auto",
            workLogsExpansion: "collapsed",
          },
        }),
      } satisfies AppControlHost["settings"]),
    vscode: {
      enter: async () => undefined,
      open: async () => ({
        reveal: { outcome: { view: "file" }, locations: [] },
        selectionIds: [],
      }),
      listSelections: () => ({ sessionId: "session-1", selections: [] }),
      removeSelection: async () => ({ state: { sessionId: "session-1", selections: [] } }),
      clearSelections: async () => ({ state: { sessionId: "session-1", selections: [] } }),
      performEditorAction: async () => null,
      ...overrides.vscode,
    },
    ...(overrides.worktrees ? { worktrees: overrides.worktrees } : null),
    projects: overrides.projectRegistry ?? { remove: async () => true },
    sessions: {
      lookup:
        overrides.lookup ??
        (async (sessionId) =>
          overrides.sessions?.().find((session) => session.sessionId === sessionId)),
      navigationEnabled: overrides.navigationEnabled ?? (() => true),
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

      query: overrides.query ?? (async () => ({ items: [] })),
      queueCommand:
        overrides.queueCommand ??
        (async () => {
          throw new Error("Unexpected queueCommand");
        }),
      reorderQueuedMessage:
        overrides.reorderQueuedMessage ??
        (async () => {
          throw new Error("Unexpected reorderQueuedMessage");
        }),
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
      removeQueuedMessage:
        overrides.removeQueuedMessage ?? (async () => ({ steering: [], followUp: [] })),
      steerQueuedMessage:
        overrides.steerQueuedMessage ?? (async () => ({ steering: [], followUp: [] })),
      sendQueuedMessageNow:
        overrides.sendQueuedMessageNow ?? (async () => ({ steering: [], followUp: [] })),
      abort: overrides.abort ?? (async () => undefined),
      rename: overrides.rename ?? (async () => undefined),
      setProjectSessionsResolved: overrides.setProjectSessionsResolved ?? (async () => 0),
    },
    presentation: {
      splitView: overrides.splitView ?? (() => undefined),
      showNotification: overrides.showNotification ?? (async () => undefined),
      showAgentAction: overrides.showAgentAction ?? (() => undefined),
    },
  };
}

describe("AppControlRegistry", () => {
  it("derives help from the input schema and decodes defaults before calling the typed handler", async () => {
    const args = Schema.Struct({
      text: Schema.Trim.check(Schema.isMinLength(1)),
      uppercase: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    });
    const run = vi.fn(
      async (
        input: typeof args.Type,
        _context: ControlContext,
        command: "app.user-selection",
      ): Promise<AppControlResult> => ({
        ok: true,
        command,
        text: input.uppercase ? input.text.toUpperCase() : input.text,
      }),
    );
    const registry = new AppControlRegistry([
      defineControl({
        command: "app.user-selection",
        args,
        scope: "global",
        discovery: { topic: "app", summary: "Read a selection." },
        run,
      }),
    ]);
    expect(registry.listTools("global")[0]?.parameters).toEqual(
      Schema.toStandardJSONSchemaV1(args)["~standard"].jsonSchema.input({ target: "draft-07" }),
    );
    const context: ControlContext = { host: createHost() };
    await expect(
      registry.invoke({ name: "app.user-selection", arguments: { text: "  selected  " } }, context),
    ).resolves.toEqual({
      result: { ok: true, command: "app.user-selection", text: "selected" },
    });
    expect(run).toHaveBeenCalledWith(
      { text: "selected", uppercase: false },
      context,
      "app.user-selection",
    );
    await expect(
      registry.invoke(
        { name: "app.user-selection", arguments: { text: "chosen", uppercase: true } },
        context,
      ),
    ).resolves.toMatchObject({ result: { text: "CHOSEN" } });
    for (const arguments_ of [{ text: "  " }, { text: "valid", uppercase: "yes" }]) {
      await expect(
        registry.invoke({ name: "app.user-selection", arguments: arguments_ }, context),
      ).rejects.toThrow();
    }
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate registrations and unknown or malformed invocations without running a handler", async () => {
    const run = vi.fn(async (): Promise<AppControlResult> => ({
      ok: true,
      command: "app.user-selection",
      text: null,
    }));
    const control = defineControl({
      command: "app.user-selection",
      args: Schema.Struct({}),
      scope: "global",
      discovery: { topic: "app", summary: "Read a selection." },
      run,
    });
    expect(() => new AppControlRegistry([control, control])).toThrow(
      "Duplicate application control app.user-selection",
    );
    const registry = new AppControlRegistry([control]);
    const context: ControlContext = { host: createHost() };
    for (const input of [
      { name: "unknown", arguments: {} },
      { name: 123, arguments: {} },
      { name: "app.user-selection" },
      { name: "app.user-selection", arguments: null },
    ]) {
      await expect(registry.invoke(input, context)).rejects.toThrow();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("separates discovery scope from execution, retaining assistant-only and internal controls", async () => {
    const registry = new AppControlRegistry([
      defineControl({
        command: "app.user-selection",
        args: Schema.Struct({}),
        scope: "global",
        discovery: { topic: "app", summary: "Read a selection." },
        run: async (_input, _context, command) => ({ ok: true, command, text: null }),
      }),
      defineControl({
        command: "vscode.enter",
        args: Schema.Struct({}),
        scope: "session-assistant",
        discovery: { topic: "vscode", summary: "Enter the editor." },
        run: async (_input, _context, command) => ({ ok: true, command, entered: true }),
      }),
      defineControl({
        command: "worktrees.merge",
        args: Schema.Struct({}),
        scope: "internal",
        run: async (_input, _context, command) => ({
          ok: false,
          command,
          error: "Managed Worktree controls are unavailable",
        }),
      }),
    ]);
    expect(registry.listTools("global").map((tool) => tool.command)).toEqual([
      "app.user-selection",
    ]);
    expect(registry.listTools("session-assistant").map((tool) => tool.command)).toEqual([
      "app.user-selection",
      "vscode.enter",
    ]);
    const context: ControlContext = { host: createHost() };
    await expect(
      registry.invoke({ name: "vscode.enter", arguments: {} }, context),
    ).resolves.toMatchObject({ result: { entered: true } });
    await expect(
      registry.invoke({ name: "worktrees.merge", arguments: {} }, context),
    ).resolves.toMatchObject({ result: { ok: false, command: "worktrees.merge" } });
  });
});

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
    expect(target.tools.some((tool) => tool.command === "projects.settings.get")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "projects.settings.update")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "project.settings.get")).toBe(false);
    expect(target.tools.some((tool) => tool.command === "sessions.rename")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "sessions.set-labels")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "session-labels.add")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "session-labels.update")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "session-labels.remove")).toBe(true);
    const create = target.tools.find((tool) => tool.command === "sessions.create");
    expect(create && "guidance" in create ? create.guidance : undefined).toContainEqual(
      expect.stringContaining("Omit model unless the user explicitly asks"),
    );
    expect(create?.examples?.[0]?.input).not.toHaveProperty("model");
    expect(create?.examples?.[1]?.input).toMatchObject({ model: "Sol" });
    const parameters = JSON.stringify(create?.parameters);
    expect(parameters).toContain('"type":"string"');
    expect(parameters).toContain('"provider"');
    expect(parameters).toContain('"modelId"');
    expect(parameters).toContain('"thinkingLevel"');
    expect(parameters).toContain('"fastMode"');
  });

  it("gives the session assistant parent-scoped embedded VS Code controls", async () => {
    const enter = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({
      reveal: { outcome: { view: "file" as const }, locations: [] },
      selectionIds: [],
    }));
    const performEditorAction = vi.fn(
      async (_source: AgentControlSource, action: VscodeEditorAction) => action,
    );
    const bridge = new AppControlBridge(
      createHost({ vscode: { enter, open, performEditorAction } }),
    );
    const source: AgentControlSource = {
      kind: "project-session",
      sessionId: "parent-session",
      title: "Parent",
      projectName: "Project",
      projectPath: "/project",
      workingDirectory: "/project/worktree",
    };

    expect(listAppControlTools().map(({ command }) => command)).not.toContain("vscode.enter");
    expect(listSessionAssistantControlTools().map(({ command }) => command)).toEqual(
      expect.arrayContaining([
        "vscode.enter",
        "vscode.open",
        "vscode.layout.set",
        "vscode.diff.open",
        "vscode.editor.status",
        "vscode.diagnostics.list",
        "vscode.panel.show",
      ]),
    );
    await expect(
      bridge.invoke({ name: "vscode.enter", arguments: {} }, source),
    ).resolves.toMatchObject({ ok: true, command: "vscode.enter", entered: true });
    await expect(
      bridge.invoke(
        {
          name: "vscode.open",
          arguments: {
            path: "src/main.ts",
            group: "beside",
            preview: false,
            line: 4,
            column: 2,
            endLine: 5,
          },
        },
        source,
      ),
    ).resolves.toMatchObject({
      ok: true,
      command: "vscode.open",
      opened: {
        kind: "working-directory",
        path: "src/main.ts",
        group: "beside",
        preview: false,
        range: { start: { line: 3, column: 1 }, end: { line: 4 } },
      },
    });
    expect(enter).toHaveBeenCalledWith(source);
    expect(open).toHaveBeenCalledWith(source, {
      kind: "working-directory",
      path: "src/main.ts",
      group: "beside",
      preview: false,
      range: { start: { line: 3, column: 1 }, end: { line: 4 } },
    });

    await expect(
      bridge.invoke({ name: "vscode.layout.set", arguments: { layout: "two-columns" } }, source),
    ).resolves.toMatchObject({
      ok: true,
      command: "vscode.layout.set",
      result: { type: "layout.set", layout: "two-columns" },
    });
    expect(performEditorAction).toHaveBeenCalledWith(source, {
      type: "layout.set",
      layout: "two-columns",
    });
  });

  it("invokes internal Managed Worktree merge and discard controls without advertising them globally", async () => {
    const merge = vi.fn(async () => "operation-1");
    const discard = vi.fn(async () => undefined);
    const bridge = new AppControlBridge(createHost({ worktrees: { merge, discard } }));

    await expect(
      bridge.invoke({
        name: "worktrees.merge",
        arguments: { sessionId: "child", workingDirectory: "/child-worktree" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "worktrees.merge",
      operationId: "operation-1",
    });
    await expect(
      bridge.invoke({
        name: "worktrees.discard",
        arguments: {
          sessionId: "child",
          workingDirectory: "/child-worktree",
          keepBranch: false,
        },
      }),
    ).resolves.toMatchObject({ ok: true, command: "worktrees.discard" });
    expect(merge).toHaveBeenCalledWith({
      sessionId: "child",
      workingDirectory: "/child-worktree",
    });
    expect(discard).toHaveBeenCalledWith({
      sessionId: "child",
      workingDirectory: "/child-worktree",
      keepBranch: false,
    });
    expect(listAppControlTools().map(({ command }) => command)).not.toContain("worktrees.merge");
  });

  it("removes a registered Project through the window's removal workflow without advertising it", async () => {
    const remove = vi.fn(async () => true);
    const showAgentAction = vi.fn();
    const source = { kind: "cake-chat" as const, sessionId: "cake-chat", title: "Cake Chat" };
    const bridge = new AppControlBridge(
      createHost({
        projectRegistry: { remove },
        showAgentAction,
        projects: () => [
          {
            path: "/projects/agents",
            name: "agents",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    await expect(
      bridge.invoke({ name: "projects.remove", arguments: { path: "/projects/agents" } }, source),
    ).resolves.toEqual({
      ok: true,
      command: "projects.remove",
      path: "/projects/agents",
      name: "agents",
      deleteSessions: false,
    });
    expect(remove).toHaveBeenCalledWith("/projects/agents", false);
    expect(showAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ source, message: "Removed Project “agents”" }),
    );

    await expect(
      bridge.invoke({ name: "projects.remove", arguments: { path: "/projects/unknown" } }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No registered Project has the exact path /projects/unknown",
    });
    remove.mockResolvedValueOnce(false);
    await expect(
      bridge.invoke({
        name: "projects.remove",
        arguments: { path: "/projects/agents", deleteSessions: true },
      }),
    ).resolves.toMatchObject({ ok: false, command: "projects.remove" });
    expect(remove).toHaveBeenLastCalledWith("/projects/agents", true);
    expect(listAppControlTools().map(({ command }) => command)).not.toContain("projects.remove");
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

  it("reads the current user-highlighted text without retaining a stale selection", async () => {
    let selectedText: string | null = "highlighted passage";
    const bridge = new AppControlBridge(createHost({ userSelection: () => selectedText }));

    await expect(bridge.invoke({ name: "app.user-selection", arguments: {} })).resolves.toEqual({
      ok: true,
      command: "app.user-selection",
      text: "highlighted passage",
    });
    selectedText = null;
    await expect(bridge.invoke({ name: "app.user-selection", arguments: {} })).resolves.toEqual({
      ok: true,
      command: "app.user-selection",
      text: null,
    });
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

  it("reads and updates window-local Cake settings through the invoking window", async () => {
    const get = vi.fn(() => ({
      section: "appearance" as const,
      settings: {
        theme: "system" as const,
        projectAvatarsEnabled: true,
        sessionAvatarsEnabled: true,
        sidebarCharactersEnabled: false,
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
        sidebarCharactersEnabled: true,
        workLogViewMode: "auto" as const,
        workLogsExpansion: "collapsed" as const,
      },
    }));
    const bridge = new AppControlBridge(createHost({ settings: { get, update } }));

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
        arguments: {
          section: "appearance",
          changes: { theme: "dark", sidebarCharactersEnabled: true },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "settings.update",
      scope: "window",
      section: "appearance",
      settings: { theme: "dark", sidebarCharactersEnabled: true },
    });
    expect(get).toHaveBeenCalledWith("appearance");
    expect(update).toHaveBeenCalledWith({
      section: "appearance",
      changes: { theme: "dark", sidebarCharactersEnabled: true },
    });

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

  describe("cross-session receipts", () => {
    const otherSession = {
      workingDirectory: "/projects/cake",
      projectName: "Cake",
      sessionId: "session-2",
      title: "Sibling session",
      modifiedAt: "2026-09-04T12:00:00.000Z",
      messageCount: 2,
      resolved: false,
      draft: false,
    };
    const coordinationHost = (showAgentAction: () => void) =>
      createHost({
        showAgentAction,
        sessions: () => [otherSession],
        projects: () => [
          {
            path: "/projects/cake",
            name: "Cake",
            addedAt: "2026-03-01T12:00:00.000Z",
            lastOpenedAt: "2026-03-01T12:00:00.000Z",
          },
        ],
        create: async () => ({ workspacePath: "/projects/cake", sessionId: "session-new" }),
        sessionActivity: () => "running",
        abort: async () => undefined,
      });
    const createSession = {
      name: "sessions.create",
      arguments: { workspacePath: "/projects/cake", name: "New work", initialPrompt: "Go" },
    };

    it("does not announce Cake Chat coordinating other sessions", async () => {
      const showAgentAction = vi.fn();
      const bridge = new AppControlBridge(coordinationHost(showAgentAction));
      const source = { kind: "cake-chat" as const, sessionId: "chat-1", title: "Cake Chat" };

      await expect(bridge.invoke(createSession, source)).resolves.toMatchObject({ ok: true });
      await expect(
        bridge.invoke({ name: "sessions.abort", arguments: { sessionId: "session-2" } }, source),
      ).resolves.toMatchObject({ ok: true });

      expect(showAgentAction).not.toHaveBeenCalled();
    });

    it("still announces Cake Chat actions on itself", async () => {
      const showAgentAction = vi.fn();
      const bridge = new AppControlBridge(coordinationHost(showAgentAction));
      const source = { kind: "cake-chat" as const, sessionId: "chat-1", title: "Cake Chat" };

      await bridge.invoke(
        { name: "agent.action", arguments: { action: "set-model", detail: "openai/gpt-5" } },
        source,
      );

      expect(showAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({ source, targetSessionId: "chat-1", targetKind: "cake-chat" }),
      );
    });

    it("announces a Project Session creating a sibling session", async () => {
      const showAgentAction = vi.fn();
      const bridge = new AppControlBridge(coordinationHost(showAgentAction));
      const source = {
        kind: "project-session" as const,
        sessionId: "session-1",
        title: "Planner",
      };

      await bridge.invoke(createSession, source);

      expect(showAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          source,
          message: "Created and started “New work”",
          targetSessionId: "session-new",
        }),
      );
    });
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
      compact: compactSession,
      scheduleMessage: scheduleSessionMessage,
    });
    const bridge = new AppControlBridge(host);
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
      scheduledMessage: { targetSessionId: "session-2", sendAt: "2030-01-01T12:00:00.000Z" },
    });
    expect(compactSession).toHaveBeenCalledWith("session-2", "Keep decisions");
    expect(scheduleSessionMessage).toHaveBeenCalledWith({
      targetSessionId: "session-2",
      text: "Review this",
      sendAt: "2030-01-01T12:00:00.000Z",
    });
  });

  it("stops an active explicitly targeted session", async () => {
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
        abort: abortSession,
      }),
    );
    await expect(
      bridge.invoke({ name: "sessions.abort", arguments: { sessionId: "session-2" } }),
    ).resolves.toMatchObject({ ok: true, command: "sessions.abort", status: "stopping" });
    expect(abortSession).toHaveBeenCalledWith("session-2", { by: "user" });
    // An agent's stop is attributed to it, with its reason, so it is never read as a failure.
    await expect(
      bridge.invoke(
        {
          name: "sessions.abort",
          arguments: { sessionId: "session-2", reason: "The user asked to stop" },
        },
        { kind: "cake-chat", sessionId: "cake-chat", title: "Cake Chat" },
      ),
    ).resolves.toMatchObject({ ok: true, status: "stopping" });
    expect(abortSession).toHaveBeenLastCalledWith("session-2", {
      by: "session",
      sessionId: "cake-chat",
      title: "Cake Chat",
      reason: "The user asked to stop",
    });
  });

  it("controls a child's individual queued inputs and clears its remaining queue", async () => {
    const removeQueuedMessage = vi.fn(async () => ({ steering: [], followUp: ["second"] }));
    const steerQueuedMessage = vi.fn(async () => ({ steering: ["second"], followUp: [] }));
    const sendQueuedMessageNow = vi.fn(async () => ({ steering: [], followUp: [] }));
    const dequeuePendingMessages = vi.fn(async () => ({ steering: ["third"], followUp: [] }));
    const bridge = new AppControlBridge(
      createHost({
        sessions: () => [
          {
            workingDirectory: "/projects/other",
            projectName: "Other",
            sessionId: "child",
            title: "Child",
            modifiedAt: "2026-09-04T12:00:00.000Z",
            messageCount: 2,
            resolved: false,
            draft: false,
            familyParentSessionId: "parent",
          },
        ],
        removeQueuedMessage,
        steerQueuedMessage,
        sendQueuedMessageNow,
        dequeuePendingMessages,
      }),
    );
    for (const name of [
      "sessions.cancel-queued",
      "sessions.steer-queued",
      "sessions.send-now",
    ] as const) {
      await expect(
        bridge.invoke({ name, arguments: { sessionId: "child", partId: "queued-follow-up-id-1" } }),
      ).resolves.toMatchObject({ ok: true, command: name });
    }
    await expect(
      bridge.invoke({ name: "sessions.clear-queue", arguments: { sessionId: "child" } }),
    ).resolves.toMatchObject({ ok: true, cleared: { steeringCount: 1, followUpCount: 0 } });
    expect(removeQueuedMessage).toHaveBeenCalledWith("child", "queued-follow-up-id-1");
    expect(steerQueuedMessage).toHaveBeenCalledWith("child", "queued-follow-up-id-1");
    expect(sendQueuedMessageNow).toHaveBeenCalledWith("child", "queued-follow-up-id-1");
    expect(dequeuePendingMessages).toHaveBeenCalledWith("child");
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

  it("recovers exact UUIDs for open and rename when discovery is missing, while undiscovered short references fail", async () => {
    const sessionId = "10000000-0000-4000-8000-000000000011";
    const recovered = {
      workingDirectory: "/managed-worktree",
      projectName: "Project",
      sessionId,
      title: "Attachment assignment",
      modifiedAt: "2026-01-01",
      messageCount: 1,
      resolved: false,
      draft: false,
    };
    let discovered: (typeof recovered)[] = [];
    const lookup = vi.fn(async (id: string) => {
      if (id !== sessionId) return undefined;
      discovered = [recovered];
      return recovered;
    });
    const open = vi.fn(async () => true);
    const rename = vi.fn(async () => undefined);
    const bridge = new AppControlBridge(
      createHost({
        sessions: () => discovered,
        lookup,
        open,
        rename,
      }),
    );
    for (const command of ["sessions.open", "sessions.rename"] as const) {
      discovered = [];
      await expect(
        bridge.invoke({
          name: command,
          arguments: {
            sessionId,
            ...(command === "sessions.rename" ? { title: "Updated assignment" } : {}),
          },
        }),
      ).resolves.toMatchObject({ ok: true, command });
    }

    expect(open).toHaveBeenCalledWith(sessionId);
    expect(rename).toHaveBeenCalledWith(sessionId, "Updated assignment");
    discovered = [];
    const count = lookup.mock.calls.length;
    await expect(
      bridge.invoke({ name: "sessions.open", arguments: { sessionId: "00000011" } }),
    ).resolves.toMatchObject({ ok: false });
    expect(lookup).toHaveBeenCalledTimes(count);
  });

  it("does not report an unsuccessful session open as success and accepts a later retry", async () => {
    const open = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const bridge = new AppControlBridge(
      createHost({
        open,
        sessions: () => [
          {
            workingDirectory: "/project",
            projectName: "Project",
            sessionId: "target",
            title: "Target",
            modifiedAt: "2026-01-01T00:00:00.000Z",
            messageCount: 1,
            resolved: true,
            draft: false,
          },
        ],
      }),
    );
    const invocation = { name: "sessions.open", arguments: { sessionId: "target" } };
    await expect(bridge.invoke(invocation)).resolves.toEqual({
      ok: false,
      command: "sessions.open",
      error: "Cake could not open that session.",
    });
    await expect(bridge.invoke(invocation)).resolves.toMatchObject({
      ok: true,
      command: "sessions.open",
      opened: { sessionId: "target" },
    });
  });

  it("discovers backend and window controls together and validates window queue commands", async () => {
    const tools = listSessionAssistantControlTools().map(({ command }) => command);
    for (const tool of listAppControlTools()) expect(tools).toContain(tool.command);
    expect(tools).toEqual(
      expect.arrayContaining([
        "sessions.cake",
        "sessions.queue-command",
        "sessions.history",
        "sessions.compactions",
        "sessions.context",
        "sessions.usage",
        "sessions.tree",
        "sessions.commands",
        "sessions.reorder",
      ]),
    );
    const queueCommand = vi.fn(async () => ({
      itemId: "00000000-0000-4000-8000-000000000001",
      status: "queued" as const,
    }));
    const query = vi.fn(async () => ({ entries: [], total: 0 }));

    const bridge = new AppControlBridge(
      createHost({
        sessions: () => [
          {
            sessionId: "parent",
            title: "Parent",
            workingDirectory: "/project",
            projectName: "Project",
            modifiedAt: "2026-01-01T00:00:00Z",
            messageCount: 1,
            resolved: false,
            draft: false,
          },
        ],
        queueCommand,
        query,
      }),
    );
    await expect(
      bridge.invoke({
        name: "sessions.queue-command",
        arguments: { sessionId: "parent", command: "/toolcompact" },
      }),
    ).resolves.toMatchObject({ ok: true, status: "queued" });
    expect(queueCommand).toHaveBeenCalledWith("parent", "/toolcompact");
    await expect(
      bridge.invoke({
        name: "sessions.queue-command",
        arguments: { sessionId: "parent", command: "not a slash command" },
      }),
    ).rejects.toThrow();
  });
});
