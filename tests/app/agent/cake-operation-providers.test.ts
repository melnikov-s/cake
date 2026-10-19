import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCakeSessionRuntime,
  type CakeSessionRuntime,
  type CakeSessionRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-session-runtime";
import {
  configureCakeSessionRuntime,
  projectCakeOperations,
  coordinatorCakeOperations,
} from "../../../src/layers/CakeOperations";
import type { ProjectCakeOperations } from "../../../src/contracts/agent/cake-operation-api";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const directories: string[] = [];
const runtimes: CakeSessionRuntime[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const options = (cwd: string): CakeSessionRuntimeOptions => ({
  cwd,
  agentDir: join(cwd, "agent"),
  sessionDir: join(cwd, "sessions"),
  trusted: false,
  newSession: true,
  requestUi: async () => undefined,
  onEvent: () => undefined,
});

const bridge = (): Parameters<ProjectCakeOperations>[0] => ({
  host: { appendEntry: vi.fn() },
  api: vi.fn(() => {
    throw new Error("The session is not ready");
  }),
  sessionId: () => undefined,
  publishSnapshot: async () => undefined,
  getAvailableOfType: async () => [],
});

const context = {
  signal: new AbortController().signal,
  toolCallId: "fixture",
  runtime: { sessionId: "fixture", assistantEntryId: "assistant" },
};

describe("Backend-owned Cake operation composition", () => {
  it("assembles domain operations before the live session API exists", () => {
    const callbacks = bridge();
    const registry = new CakeOperationRegistry(
      projectCakeOperations({ cwd: "/workspace" })(callbacks),
    );
    expect(callbacks.api).not.toHaveBeenCalled();
    expect(registry.operationHelp("session.info")).toContain("sessionFile");
    expect(registry.operationHelp("interview.open")).toContain("responseSchema");
    expect(registry.operationHelp("artifacts.create")).toContain("durable");
    expect(registry.operationHelp("sessions.create-child")).toBeUndefined();
  });

  it("preserves read-only auxiliary trimming and separately granted parent controls", () => {
    const registry = new CakeOperationRegistry(
      projectCakeOperations({
        cwd: "/workspace",
        auxiliary: true,
        tools: ["read"],
        allowedCakeOperations: ["session.info", "artifacts.create"],
        sessionControl: {
          tools: [
            {
              command: "app.state",
              topic: "app",
              summary: "Parent state",
              parameters: { type: "object" },
            },
          ],
          invoke: async () => ({ parent: true }),
        },
      })(bridge()),
    );
    expect(registry.definitions().map((operation) => operation.command)).toEqual([
      "session.info",
      "app.state",
    ]);
  });

  it("composes coordinator model control through injected callbacks and its allowlist", async () => {
    const model = {
      provider: "fixture",
      modelId: "fixture",
      thinkingLevel: "off" as const,
      fastMode: false,
    };
    const resolveModel = vi.fn(() => model);
    const setModel = vi.fn(async () => undefined);
    const configured = configureCakeSessionRuntime({
      ...options("/workspace"),
      globalControl: { tools: [], invoke: async () => ({}) },
      allowedCakeOperations: ["session.set-model"],
    });
    if (!configured.coordinator) throw new Error("Expected coordinator composition");
    const registry = new CakeOperationRegistry(
      configured.coordinator.operations({
        sessionId: "coordinator",
        resolveModel,
        setModel,
        info: async () => ({}),
        usage: async () => ({}),
        contextStatus: async () => ({}),
        compact: async () => ({}),
      }),
    );
    expect(registry.definitions().map((operation) => operation.command)).toEqual([
      "session.set-model",
    ]);
    const result = await registry.invoke(
      { command: "session.set-model", input: { model: "Sol" } },
      context,
    );
    expect(resolveModel).toHaveBeenCalledWith("Sol");
    expect(setModel).toHaveBeenCalledWith(model);
    expect(result.details).toMatchObject({ result: model });
  });

  it("resolves Cake Chat's omitted-model subagents as subagent launches", async () => {
    const model = {
      provider: "anthropic",
      modelId: "claude-sonnet",
      thinkingLevel: "medium" as const,
      fastMode: true,
    };
    const resolveModel = vi.fn(() => model);
    const start = vi.fn(async () => ({ status: "running" }));
    const unused = async () => ({});
    const configured = configureCakeSessionRuntime({
      ...options("/workspace"),
      globalControl: { tools: [], invoke: async () => ({}) },
      agentControl: {
        run: unused,
        start,
        parallel: unused,
        prompt: unused,
        wait: unused,
        abort: unused,
        close: unused,
      },
      allowedCakeOperations: ["subagents.start"],
    });
    if (!configured.coordinator) throw new Error("Expected coordinator composition");
    const registry = new CakeOperationRegistry(
      configured.coordinator.operations({
        sessionId: "coordinator",
        resolveModel,
        setModel: async () => undefined,
        info: async () => ({}),
        usage: async () => ({}),
        contextStatus: async () => ({}),
        compact: async () => ({}),
      }),
    );
    await registry.invoke({ command: "subagents.start", input: { task: "Investigate" } }, context);
    expect(resolveModel).toHaveBeenCalledWith(undefined, "subagent");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          prefer: "exact",
          provider: "anthropic",
          modelId: "claude-sonnet",
          thinkingLevel: "medium",
        },
        fastMode: true,
      }),
      "coordinator",
      context.signal,
      expect.anything(),
    );
  });

  it("exposes validated permanent guidance tools only through coordinator composition", async () => {
    const get = vi.fn(async () => ({ instructions: "Existing guidance." }));
    const update = vi.fn(async (input: { instructions: string }) => ({
      instructions: input.instructions,
    }));
    const configured = configureCakeSessionRuntime({
      ...options("/workspace"),
      globalControl: { tools: [], invoke: vi.fn() },
      cakeChatInstructions: { get, update },
      allowedCakeOperations: ["settings.cake-chat.get", "settings.cake-chat.update"],
    });
    if (!configured.coordinator) throw new Error("Expected coordinator composition");
    const registry = new CakeOperationRegistry(
      configured.coordinator.operations({
        sessionId: "coordinator",
        resolveModel: () => ({
          provider: "p",
          modelId: "m",
          thinkingLevel: "off",
          fastMode: false,
        }),
        setModel: async () => undefined,
        info: async () => ({}),
        usage: async () => ({}),
        contextStatus: async () => ({}),
        compact: async () => ({}),
      }),
    );
    expect(registry.definitions().map((operation) => operation.command)).toEqual([
      "settings.cake-chat.get",
      "settings.cake-chat.update",
    ]);
    expect(registry.help()).toContain("settings");
    expect(registry.operationHelp("settings.cake-chat.update")).toContain("expectedInstructions");
    expect(registry.operationHelp("settings.cake-chat.update")).toContain("next Cake Chat message");
    const read = await registry.invoke({ command: "settings.cake-chat.get" }, context);
    expect(read.details).toMatchObject({ result: { instructions: "Existing guidance." } });
    expect(get).toHaveBeenCalledWith(context.signal);
    const input = {
      expectedInstructions: "Existing guidance.",
      instructions: "Existing guidance.\nNew guidance.",
    };
    const saved = await registry.invoke({ command: "settings.cake-chat.update", input }, context);
    expect(update).toHaveBeenCalledWith(input, context.signal);
    expect(saved.details).toMatchObject({ result: { instructions: input.instructions } });
    for (const invalid of [
      { instructions: "Missing read." },
      { expectedInstructions: "", instructions: "x".repeat(16_385) },
      { expectedInstructions: 1, instructions: "Wrong type." },
    ])
      await expect(
        registry.invoke({ command: "settings.cake-chat.update", input: invalid }, context),
      ).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
    update.mockRejectedValueOnce(new Error("Persistence failed"));
    await expect(
      registry.invoke({ command: "settings.cake-chat.update", input }, context),
    ).rejects.toThrow("Persistence failed");
    const cancelled = { ...context, signal: AbortSignal.abort() };
    await expect(
      registry.invoke({ command: "settings.cake-chat.update", input }, cancelled),
    ).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(2);
    // Passing a capability does not give ordinary Project Sessions coordinator authority.
    const project = new CakeOperationRegistry(
      projectCakeOperations({ cwd: "/workspace", cakeChatInstructions: { get, update } })(bridge()),
    );
    expect(
      project
        .definitions()
        .every((operation) => !operation.command.startsWith("settings.cake-chat.")),
    ).toBe(true);
  });

  it("validates explicit Project Chat targets and reports only successful committed writes", async () => {
    let committed = "Existing.";
    const get = vi.fn(async (input: { projectPath: string }) => ({
      ...input,
      instructions: committed,
    }));
    const update = vi.fn(
      async (input: {
        projectPath: string;
        expectedInstructions: string;
        instructions: string;
      }) => {
        committed = input.instructions;
        return { projectPath: input.projectPath, instructions: committed };
      },
    );
    const registry = new CakeOperationRegistry(
      coordinatorCakeOperations({
        cwd: "/workspace",
        projectChatInstructions: { get, update },
        globalControl: { tools: [], invoke: vi.fn() },
        allowedCakeOperations: ["settings.project-chat.get", "settings.project-chat.update"],
      })({
        sessionId: "coordinator",
        resolveModel: () => ({
          provider: "p",
          modelId: "m",
          thinkingLevel: "off",
          fastMode: false,
        }),
        setModel: async () => undefined,
        info: async () => ({}),
        usage: async () => ({}),
        contextStatus: async () => ({}),
        compact: async () => ({}),
      }),
    );
    const input = {
      projectPath: "/zombies",
      expectedInstructions: "Existing.",
      instructions: "Merged.",
    };
    const read = await registry.invoke(
      { command: "settings.project-chat.get", input: { projectPath: input.projectPath } },
      context,
    );
    expect(read.details).toMatchObject({
      result: { projectPath: "/zombies", instructions: "Existing." },
    });
    expect(registry.operationHelp("settings.project-chat.update")).toContain(
      "Read back the same projectPath before claiming success",
    );
    const saved = await registry.invoke(
      { command: "settings.project-chat.update", input },
      context,
    );
    expect(saved.details).toMatchObject({
      result: { projectPath: "/zombies", instructions: "Merged." },
    });
    expect(update).toHaveBeenCalledWith(input, context.signal);
    const readback = await registry.invoke(
      { command: "settings.project-chat.get", input: { projectPath: "/zombies" } },
      context,
    );
    expect(readback.details).toMatchObject({ result: { instructions: "Merged." } });
    for (const invalid of [
      { expectedInstructions: "", instructions: "No project." },
      { projectPath: "/zombies", instructions: "No read." },
      { projectPath: "/zombies", expectedInstructions: "Merged." },
      { ...input, instructions: "x".repeat(16_385) },
    ])
      await expect(
        registry.invoke({ command: "settings.project-chat.update", input: invalid }, context),
      ).rejects.toThrow();
    update.mockRejectedValueOnce(new Error("Storage failed"));
    await expect(
      registry.invoke({ command: "settings.project-chat.update", input }, context),
    ).rejects.toThrow("Storage failed");
    await expect(
      registry.invoke(
        { command: "settings.project-chat.update", input },
        { ...context, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(2);
    const coding = new CakeOperationRegistry(
      projectCakeOperations({ cwd: "/workspace", projectChatInstructions: { get, update } })(
        bridge(),
      ),
    );
    expect(
      coding
        .definitions()
        .some((operation) => operation.command.startsWith("settings.project-chat.")),
    ).toBe(false);
  });

  it("exposes Cake Chat's native worktree merge by session reference", async () => {
    const merge = vi.fn(async () => ({ command: "worktrees.merge", outcome: "landed" }));
    const configured = configureCakeSessionRuntime({
      ...options("/workspace"),
      globalControl: { tools: [], invoke: vi.fn() },
      cakeChatWorktrees: { merge },
      allowedCakeOperations: ["worktrees.merge"],
    });
    if (!configured.coordinator) throw new Error("Expected coordinator composition");
    const registry = new CakeOperationRegistry(
      configured.coordinator.operations({
        sessionId: "coordinator",
        resolveModel: () => ({
          provider: "p",
          modelId: "m",
          thinkingLevel: "off",
          fastMode: false,
        }),
        setModel: async () => undefined,
        info: async () => ({}),
        usage: async () => ({}),
        contextStatus: async () => ({}),
        compact: async () => ({}),
      }),
    );
    expect(registry.definitions().map((operation) => operation.command)).toEqual([
      "worktrees.merge",
    ]);
    expect(registry.help()).toContain("worktrees — Land (merge) Cake-managed worktrees");
    const help = registry.operationHelp("worktrees.merge");
    expect(help).toContain("identical to the Merge action in the Cake UI");
    expect(help).toContain("prompts the owning session to resolve them inside its own worktree");
    expect(help).toContain("Never land Cake-managed worktree work by hand");
    const result = await registry.invoke(
      { command: "worktrees.merge", input: { sessionId: "1a2b3c4d" } },
      context,
    );
    expect(merge).toHaveBeenCalledWith("1a2b3c4d", context.signal);
    expect(result.details).toMatchObject({ result: { outcome: "landed" } });
    await expect(
      registry.invoke({ command: "worktrees.merge", input: {} }, context),
    ).rejects.toThrow();
  });

  it("exposes Cake Chat's Project registry as a discoverable projects topic", async () => {
    const project = {
      path: "/Users/me/world/trees/agents",
      name: "agents",
      addedAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      trusted: false,
    };
    const control = {
      list: vi.fn(async () => ({
        projects: [{ path: project.path, name: project.name }],
        total: 1,
        offset: 0,
        nextOffset: null,
      })),
      info: vi.fn(async () => ({ project })),
      add: vi.fn(async () => ({ project, alreadyRegistered: false })),
      rename: vi.fn(async () => ({ project: { ...project, name: "Agents" } })),
      remove: vi.fn(async () => ({ ok: true, path: project.path, deleteSessions: false })),
    };
    const commands = [
      "projects.list",
      "projects.info",
      "projects.add",
      "projects.rename",
      "projects.remove",
    ];
    const configured = configureCakeSessionRuntime({
      ...options("/workspace"),
      globalControl: { tools: [], invoke: vi.fn() },
      cakeChatProjects: control,
      allowedCakeOperations: commands,
    });
    if (!configured.coordinator) throw new Error("Expected coordinator composition");
    const registry = new CakeOperationRegistry(
      configured.coordinator.operations({
        sessionId: "coordinator",
        resolveModel: () => ({
          provider: "p",
          modelId: "m",
          thinkingLevel: "off",
          fastMode: false,
        }),
        setModel: async () => undefined,
        info: async () => ({}),
        usage: async () => ({}),
        contextStatus: async () => ({}),
        compact: async () => ({}),
      }),
    );
    expect(registry.definitions().map((operation) => operation.command)).toEqual(commands);
    expect(registry.help()).toContain("projects — List, register (add), rename, and remove");
    const help = registry.operationHelp("projects.add");
    expect(help).toContain("delegate it to an allowMutations worker first");
    expect(help).toContain("alreadyRegistered");
    expect(help).toContain("/Users/me/world/trees/agents");

    const added = await registry.invoke(
      { command: "projects.add", input: { path: project.path, name: " Agents " } },
      context,
    );
    expect(control.add).toHaveBeenCalledWith(
      { path: project.path, name: "Agents" },
      context.signal,
    );
    expect(added.details).toMatchObject({ result: { project, alreadyRegistered: false } });
    await registry.invoke({ command: "projects.remove", input: { path: project.path } }, context);
    expect(control.remove).toHaveBeenCalledWith(
      { path: project.path, deleteSessions: false },
      context.signal,
    );
    await registry.invoke({ command: "projects.list" }, context);
    expect(control.list).toHaveBeenCalledWith({}, context.signal);
    await registry.invoke({ command: "projects.info", input: { path: project.path } }, context);
    expect(control.info).toHaveBeenCalledWith({ path: project.path }, context.signal);
    await expect(
      registry.invoke({ command: "projects.add", input: { name: "No path" } }, context),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        { command: "projects.rename", input: { path: project.path, name: " " } },
        context,
      ),
    ).rejects.toThrow();
    expect(control.rename).not.toHaveBeenCalled();

    // Ordinary Project Sessions never receive Cake Chat's Project registry authority.
    const projectSession = new CakeOperationRegistry(
      projectCakeOperations({ cwd: "/workspace", cakeChatProjects: control })(bridge()),
    );
    expect(projectSession.definitions().every((operation) => operation.topic !== "projects")).toBe(
      true,
    );
  });

  it("rejects coordinator composition without its authority", () => {
    expect(() => coordinatorCakeOperations({ cwd: "/workspace" })).toThrow(
      "coordinator control is unavailable",
    );
  });

  it("publishes appended interview metadata before requesting its answer", async () => {
    const events: string[] = [];
    const callbacks = bridge();
    callbacks.host.appendEntry = () => {
      events.push("append");
    };
    callbacks.publishSnapshot = async () => {
      events.push("publish");
    };
    const registry = new CakeOperationRegistry(
      projectCakeOperations({
        cwd: "/workspace",
        requestInterview: async () => {
          events.push("request");
          return {};
        },
      })(callbacks),
    );
    await registry.invoke(
      {
        command: "interview.open",
        input: {
          request: {
            protocol: "cake.request/v1",
            id: "fixture",
            title: "Fixture",
            responseSchema: { type: "object" },
            view: { type: "form", fields: [{ id: "answer", label: "Answer", type: "text" }] },
            fallback: { markdown: "Fixture" },
          },
        },
      },
      context,
    );
    expect(events).toEqual(["append", "publish", "request"]);
  });

  it("dispatches captured feature controls through the real Pi adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-operation-composition-"));
    directories.push(directory);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
    const enter = vi.fn(async () => undefined);
    const configured = configureCakeSessionRuntime({
      ...options(directory),
      browserControl: {
        enter,
        cdp: async () => ({ status: "completed", value: null }),
        events: async () => ({ status: "completed", value: [] }),
      },
      allowedCakeOperations: ["browser.enter"],
    });
    const runtime = await createCakeSessionRuntime(configured);
    runtimes.push(runtime);
    await runtime.callCakeOperation?.("browser.enter", {}, context.signal);
    expect(enter).toHaveBeenCalledWith(context.signal);
    expect(await runtime.callCakeOperation?.("browser", {}, context.signal)).toContain(
      "browser.enter",
    );
  });

  it("dispatches an injected feature without built-in feature assembly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-operation-factory-"));
    directories.push(directory);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
    const execute = vi.fn(async (input: { value: string }) => ({ echoed: input.value }));
    const operations = vi.fn<ProjectCakeOperations>(() => [
      {
        command: "app.injected",
        topic: "app",
        summary: "Injected feature",
        inputSchema: Schema.Struct({ value: Schema.String }),
        examples: [{ input: { value: "hello" } }],
        result: "Echoed input",
        execute: (input) =>
          execute(Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }))(input)),
      },
    ]);
    const runtime = await createCakeSessionRuntime({ ...options(directory), operations });
    runtimes.push(runtime);
    expect(operations).toHaveBeenCalledWith(
      expect.objectContaining({ api: expect.any(Function), sessionId: expect.any(Function) }),
    );
    expect(
      await runtime.callCakeOperation?.("app.injected", { value: "hello" }, context.signal),
    ).toEqual({ echoed: "hello" });
    expect(execute).toHaveBeenCalledWith({ value: "hello" });
  });
});
