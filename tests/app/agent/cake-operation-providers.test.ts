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
import { cakeOperationProviders } from "../../../src/layers/CakeOperations";
import type { CakeOperationProviders } from "../../../src/services/pi/runtime/cake-operation-providers";
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

const bridge = (): Parameters<CakeOperationProviders["project"]>[1] => ({
  host: { appendEntry: vi.fn() },
  api: vi.fn(() => {
    throw new Error("The session is not ready");
  }),
  sessionId: () => undefined,
  getAvailableOfType: async () => [],
});

describe("Backend-owned Cake operation composition", () => {
  it("assembles domain operations before the live session API exists", () => {
    const callbacks = bridge();
    const registry = new CakeOperationRegistry(
      cakeOperationProviders.project(options("/workspace"), callbacks),
    );
    expect(callbacks.api).not.toHaveBeenCalled();
    expect(registry.operationHelp("session.info")).toContain("sessionFile");
    expect(registry.operationHelp("interview.open")).toContain("responseSchema");
    expect(registry.operationHelp("artifacts.create")).toContain("durable");
    expect(registry.operationHelp("sessions.create-child")).toBeUndefined();
  });

  it("preserves read-only auxiliary trimming and separately granted parent controls", () => {
    const registry = new CakeOperationRegistry(
      cakeOperationProviders.project(
        {
          ...options("/workspace"),
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
        },
        bridge(),
      ),
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
    const registry = new CakeOperationRegistry(
      cakeOperationProviders.coordinator(
        {
          ...options("/workspace"),
          globalControl: { tools: [], invoke: async () => ({}) },
          allowedCakeOperations: ["session.set-model"],
        },
        {
          sessionId: "coordinator",
          resolveModel,
          setModel,
          info: async () => ({}),
          usage: async () => ({}),
          contextStatus: async () => ({}),
          compact: async () => ({}),
        },
      ),
    );
    expect(registry.definitions().map((operation) => operation.command)).toEqual([
      "session.set-model",
    ]);
    const result = await registry.invoke(
      { command: "session.set-model", input: { model: "Sol" } },
      {
        signal: new AbortController().signal,
        toolCallId: "set-model",
        runtime: { sessionId: "coordinator" },
      },
    );
    expect(resolveModel).toHaveBeenCalledWith("Sol");
    expect(setModel).toHaveBeenCalledWith(model);
    expect(result.details).toMatchObject({ result: model });
  });

  it("dispatches an injected feature through the real Pi adapter without built-in feature assembly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-operation-provider-"));
    directories.push(directory);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
    const execute = vi.fn(async (input: { value: string }) => ({ echoed: input.value }));
    const providers: CakeOperationProviders = {
      project: () => [
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
      ],
      coordinator: () => [],
    };
    const runtime = await createCakeSessionRuntime(options(directory), providers);
    runtimes.push(runtime);
    expect(
      await runtime.callCakeOperation?.(
        "app.injected",
        { value: "hello" },
        new AbortController().signal,
      ),
    ).toEqual({ echoed: "hello" });
    expect(execute).toHaveBeenCalledWith({ value: "hello" });
    expect(await runtime.callCakeOperation?.("app", {}, new AbortController().signal)).toContain(
      "app.injected",
    );
  });
});
