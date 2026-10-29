import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CakeChatTarget } from "../../../src/contracts/cake-chats/cake-chat-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import {
  listAppControlTools,
  listSessionAssistantControlTools,
} from "../../../src/renderer/app-control/AppControlBridge";
import type { AppControlResult } from "../../../src/renderer/app-control/app-control-data";
import { AppControlRegistry } from "../../../src/renderer/app-control/app-control-registry";
import {
  defineControl,
  type ControlContext,
} from "../../../src/renderer/app-control/control-definition";
import type { Client } from "../../../src/renderer/client/Client";
import { createCommandClientFinishFixture } from "./command-client-finish-fixture";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";

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
    using fixture = createCommandClientFinishFixture();
    const context: ControlContext = { host: fixture.root.applicationControlStore.props.host };
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
    using fixture = createCommandClientFinishFixture();
    const context: ControlContext = { host: fixture.root.applicationControlStore.props.host };
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
    using fixture = createCommandClientFinishFixture();
    const context: ControlContext = { host: fixture.root.applicationControlStore.props.host };
    await expect(
      registry.invoke({ name: "vscode.enter", arguments: {} }, context),
    ).resolves.toMatchObject({ result: { entered: true } });
    await expect(
      registry.invoke({ name: "worktrees.merge", arguments: {} }, context),
    ).resolves.toMatchObject({ result: { ok: false, command: "worktrees.merge" } });
  });
});

describe("Application controls over the real Root host", () => {
  it("constructs a Cake Chat RPC target without explicit undefined optional fields", () => {
    const target = {
      sessionId: "9f0de1b1-4baa-4706-9a41-1b9e3c90b404",
      tools: listAppControlTools(),
    };

    expect(() => Schema.decodeUnknownSync(CakeChatTarget)(target)).not.toThrow();
    expect(target.tools.some((tool) => tool.command === "app.split")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "sessions.create-draft")).toBe(true);
    expect(target.tools.some((tool) => tool.command === "notifications.send")).toBe(true);
    for (const command of [
      "settings.list",
      "settings.get",
      "settings.update",
      "settings.window.get",
      "settings.window.update",
    ])
      expect(target.tools.filter((tool) => tool.command === command)).toHaveLength(1);
    // Cake Chat registers its own strictly typed Project settings operations.
    expect(target.tools.some((tool) => tool.command === "projects.settings.get")).toBe(false);
    expect(target.tools.some((tool) => tool.command === "projects.settings.update")).toBe(false);
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

  // Agent commands have no UI initiation control. Exercise the public gateway
  // with its real Root host and assert only decoded results/service payloads.
  // Visible receipts/settings are in command-client-finish-workflow. Native
  // editor selection is in editor-selections-workflow; navigation/retry/permission
  // and exact-ID recovery are in agent-session-navigation/project-navigation.
  it("maps assistant-scoped editor actions and internal worktree controls to typed native Clients", async () => {
    const editor = vi.fn<Client["vscode"]["performEditorAction"]>(async (_path, action) => ({
      action: action.type,
    }));
    const landing = vi.fn<Client["managedWorktrees"]["startLanding"]>(async (request) => ({
      operationId: request.operationId,
      workspacePath: request.workspacePath,
      sessionId: request.sessionId,
      kind: "landing",
      phase: "waiting",
      strategy: "preserve",
      allowDirtyTarget: false,
    }));
    const discard = vi.fn<Client["managedWorktrees"]["discard"]>(async () => undefined);
    using fixture = createCommandClientFinishFixture({
      vscode: { performEditorAction: editor },
      managedWorktrees: { startLanding: landing, discard },
    });
    expect(listAppControlTools().map(({ command }) => command)).not.toContain("vscode.layout.set");
    expect(listSessionAssistantControlTools().map(({ command }) => command)).toContain(
      "vscode.layout.set",
    );
    expect(await fixture.invoke("vscode.layout.set", { layout: "two-columns" })).toMatchObject({
      ok: true,
      result: { action: "layout.set" },
    });
    expect(editor).toHaveBeenCalledExactlyOnceWith(
      "/project",
      { type: "layout.set", layout: "two-columns" },
      { signal: expect.any(AbortSignal) },
    );
    const result = await fixture.invoke("worktrees.merge", {
      sessionId: "target",
      workingDirectory: "/other",
    });
    expect(result).toMatchObject({
      ok: true,
      command: "worktrees.merge",
      operationId: expect.any(String),
    });
    expect(landing).toHaveBeenCalledExactlyOnceWith(
      {
        operationId: expect.any(String),
        workspacePath: "/other",
        sessionId: "target",
        strategy: "preserve",
        allowDirtyTarget: false,
        commitBeforeLanding: true,
        resolveAfterLanding: false,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(
      await fixture.invoke("worktrees.discard", {
        sessionId: "target",
        workingDirectory: "/other",
        keepBranch: false,
      }),
    ).toMatchObject({ ok: true });
    expect(discard).toHaveBeenCalledExactlyOnceWith(
      { operationId: expect.any(String), workspacePath: "/other", keepBranch: false },
      { signal: expect.any(AbortSignal) },
    );
    expect(listAppControlTools().map(({ command }) => command)).not.toContain("worktrees.merge");
  });

  it("creates a managed-worktree session through the real creation owner and rejects invalid names before dispatch", async () => {
    const worktree = {
      projectPath: "/project",
      worktreePath: "/feature",
      branch: "agent/feature",
      baseBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      state: "active" as const,
    };
    const create = vi.fn<Client["managedWorktrees"]["create"]>(async () => worktree);
    const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = createCommandClientFinishFixture({
      managedWorktrees: { create },
      projectSessions: { start },
    });
    const model = {
      provider: "fixture",
      modelId: "fixture",
      thinkingLevel: "high",
      fastMode: true,
    };
    const args = {
      workspacePath: "/project",
      name: "Implementation",
      initialPrompt: "Implement the approved changes",
      model,
      worktreeName: "feature",
    };
    await expect(
      fixture.invoke("sessions.create", { ...args, worktreeName: "Invalid Worktree" }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    const result = await fixture.invoke("sessions.create", args);
    expect(result).toMatchObject({
      ok: true,
      workspacePath: "/feature",
      title: "Implementation",
      status: "started",
      managedWorktree: worktree,
    });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      path: "/project",
      worktreeName: "feature",
      backgroundSetup: true,
      baseWorktreePath: undefined,
      operationId: expect.any(String),
    });
    expect(start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        workingDirectory: "/feature",
        name: "Implementation",
        text: args.initialPrompt,
        configuration: model,
        renderUserMessageAsMarkdown: true,
        attachments: [],
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("creates drafts through the external saved authority without starting Pi, and removes only exact registered Projects", async () => {
    const drafts = fakeSavedDrafts();
    const start = vi.fn<Client["projectSessions"]["start"]>();
    const remove = vi.fn<Client["workspaces"]["removeProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = createCommandClientFinishFixture({
      savedDrafts: drafts.client,
      projectSessions: { start },
      workspaces: { removeProject: remove },
    });
    expect(
      await fixture.invoke("sessions.create-draft", {
        workspacePath: "/project",
        name: "Draft session",
        initialPrompt: "Implement this later",
      }),
    ).toMatchObject({ ok: true, title: "Draft session", status: "saved-draft" });
    expect(drafts.snapshot()).toMatchObject([
      {
        projectPath: "/project",
        title: "Draft session",
        text: "Implement this later",
        status: "saved",
      },
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(await fixture.invoke("projects.remove", { path: "/missing" })).toMatchObject({
      ok: false,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(
      await fixture.invoke("projects.remove", { path: "/other", deleteSessions: true }),
    ).toMatchObject({ ok: true, path: "/other", deleteSessions: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith("/other", true, {
      signal: expect.any(AbortSignal),
    });
    expect(listAppControlTools().map(({ command }) => command)).not.toContain("projects.remove");
  });

  it("keeps command targets in another project independent of focused selection and attributes agent stop reasons", async () => {
    const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => undefined);
    const queue = vi.fn<Client["sessionChats"]["queueCommand"]>(async () => ({
      itemId: "10000000-0000-4000-8000-000000000003",
      status: "queued",
    }));
    const remove = vi.fn<Client["sessionChats"]["removeQueuedMessage"]>(async () => ({
      steering: [],
      followUp: ["second"],
    }));
    const steer = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => ({
      steering: ["second"],
      followUp: [],
    }));
    const send = vi.fn<Client["sessionChats"]["sendQueuedMessageNow"]>(async () => ({
      steering: [],
      followUp: [],
    }));
    const clear = vi.fn<Client["sessionChats"]["clearQueue"]>(async () => ({
      steering: ["third"],
      followUp: [],
    }));
    using fixture = createCommandClientFinishFixture({
      sessionChats: {
        abort,
        queueCommand: queue,
        removeQueuedMessage: remove,
        steerQueuedMessage: steer,
        sendQueuedMessageNow: send,
        clearQueue: clear,
      },
    });
    expect(
      await fixture.invoke("sessions.abort", {
        sessionId: "target",
        reason: "The user asked to stop",
      }),
    ).toMatchObject({ ok: true, status: "stopping" });
    expect(abort).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: "target",
        stop: {
          by: "session",
          sessionId: "calling",
          title: "Planner",
          reason: "The user asked to stop",
        },
      },
      { signal: expect.any(AbortSignal) },
    );
    await expect(
      fixture.invoke("sessions.queue-command", {
        sessionId: "target",
        command: "not a slash command",
      }),
    ).rejects.toThrow();
    expect(queue).not.toHaveBeenCalled();
    expect(
      await fixture.invoke("sessions.queue-command", {
        sessionId: "target",
        command: "/toolcompact",
      }),
    ).toMatchObject({ ok: true, status: "queued" });
    expect(queue).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "target", command: "/toolcompact" },
      { signal: expect.any(AbortSignal) },
    );
    for (const name of ["sessions.cancel-queued", "sessions.steer-queued", "sessions.send-now"]) {
      expect(await fixture.invoke(name, { sessionId: "target", partId: "queued-1" })).toMatchObject(
        { ok: true },
      );
    }
    for (const service of [remove, steer, send])
      expect(service).toHaveBeenCalledExactlyOnceWith(
        { sessionId: "target", partId: "queued-1" },
        { signal: expect.any(AbortSignal) },
      );
    expect(await fixture.invoke("sessions.clear-queue", { sessionId: "target" })).toMatchObject({
      ok: true,
      cleared: { steeringCount: 1, followUpCount: 0 },
    });
    expect(clear).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "target" },
      { signal: expect.any(AbortSignal) },
    );
    expect(await fixture.invoke("app.state")).toMatchObject({
      state: { selection: { sessionId: "calling" } },
    });
  });

  it("describes real pane layout relative to the caller and does not invent an unwired Cake Chat split", async () => {
    using fixture = createCommandClientFinishFixture({
      workspaces: { loadStagedSlashCommands: async () => [] },
    });
    const result = await fixture.invoke("app.split", { direction: "right" });
    expect(result).toMatchObject({
      ok: true,
      kind: "project-session",
      paneId: expect.any(String),
      sessionId: expect.any(String),
    });
    expect(await fixture.invoke("app.state")).toMatchObject({
      state: {
        sessionLayout: {
          originSessionId: "calling",
          panes: [
            { sessionId: "calling", x: 0, width: 0.5 },
            { x: 0.5, width: 0.5 },
          ],
        },
      },
    });
    const before = fixture.root.cakeChatCollectionStore.sessionLayoutStore.panes.length;
    expect(
      await fixture.invoke(
        "app.split",
        { direction: "right" },
        { kind: "cake-chat", sessionId: "cake-chat", title: "Cake Chat" },
      ),
    ).toMatchObject({ ok: false });
    expect(fixture.root.cakeChatCollectionStore.sessionLayoutStore.panes).toHaveLength(before);
  });
});
