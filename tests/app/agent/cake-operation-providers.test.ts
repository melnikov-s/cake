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
