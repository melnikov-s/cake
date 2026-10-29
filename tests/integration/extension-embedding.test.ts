import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ProviderConfig,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  Type,
  createAssistantMessageEventStream,
  createProvider,
  type Model,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInitialModelRegistered,
  registerPendingExtensionProviders,
  requireRegisteredModel,
} from "../../src/services/pi/runtime/extension-providers";
import { createCakeSessionRuntimeCapabilities } from "../../src/services/pi/runtime/cake-session-runtime-capabilities";

const directories: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const provider = "embedding-fixture";
const modelId = "local-model";
const config: ProviderConfig = {
  api: "openai-completions",
  apiKey: "fixture-not-a-credential",
  baseUrl: "http://127.0.0.1:9",
  models: [
    {
      id: modelId,
      name: "Local fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    },
  ],
};

function response(
  content: AssistantMessage["content"] = [],
  stopReason: "stop" | "toolUse" | "aborted" = "stop",
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    stopReason,
    ...(stopReason === "aborted" ? { errorMessage: "Fixture cancelled" } : {}),
    api: "openai-completions",
    provider,
    model: modelId,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
    else stream.push({ type: "done", reason: stopReason, message });
  });
  return stream;
}

async function runtimeFixture(factory: ExtensionFactory, sessionless = false) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-embedding-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-cache.json"),
  });
  const settings = SettingsManager.inMemory({
    defaultProvider: provider,
    defaultModel: modelId,
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const loader: ResourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await loader.reload();
  const errors = await registerPendingExtensionProviders(loader, runtime, { sessionless });
  return { cwd, agentDir, runtime, settings, loader, errors };
}

async function open(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  const manager = SessionManager.inMemory(fixture.cwd);
  assertInitialModelRegistered(fixture.runtime, fixture.settings, manager);
  const { session } = await createAgentSession({
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    modelRuntime: fixture.runtime,
    settingsManager: fixture.settings,
    resourceLoader: fixture.loader,
    sessionManager: manager,
    tools: fixture.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]),
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "rpc" });
  return session;
}

describe("Cake extension embedding boundaries", () => {
  it.each([true, false])(
    "registers factory providers independently (catalog first=%s)",
    async (catalogFirst) => {
      const calls = vi.fn<NonNullable<ProviderConfig["streamSimple"]>>(() => response());
      const factory: ExtensionFactory = (pi) =>
        pi.registerProvider(provider, { ...config, streamSimple: calls });
      const first = await runtimeFixture(factory, catalogFirst);
      const second = await runtimeFixture(factory, !catalogFirst);
      for (const fixture of [first, second]) {
        expect(fixture.errors).toEqual([]);
        const model = requireRegisteredModel(fixture.runtime, { provider, modelId });
        expect(await fixture.runtime.getAvailable()).toContainEqual(model);
        const controller = new AbortController();
        await fixture.runtime
          .streamSimple(model, { messages: [] }, { signal: controller.signal })
          .result();
        expect(calls.mock.lastCall?.[2]?.signal).toBe(controller.signal);
      }
      expect(calls).toHaveBeenCalledTimes(2);
    },
  );

  it.each([true, false])(
    "rejects first-instance/deferred registration before fallback (catalog first=%s)",
    async (catalogFirst) => {
      let firstInstance = true;
      const factory: ExtensionFactory = (pi) => {
        if (firstInstance) {
          firstInstance = false;
          pi.registerProvider(provider, { ...config, streamSimple: () => response() });
        } else {
          pi.on("session_start", () => pi.registerProvider(provider, config));
        }
      };
      await runtimeFixture(factory, catalogFirst);
      const second = await runtimeFixture(factory, !catalogFirst);
      const manager = SessionManager.inMemory(second.cwd);
      manager.appendModelChange(provider, modelId);
      const before = manager.getBranch();
      expect(() => assertInitialModelRegistered(second.runtime, second.settings, manager)).toThrow(
        /register in every extension factory invocation.*session_start/,
      );
      expect(manager.getBranch()).toEqual(before);
      expect(second.runtime.getModel(provider, modelId)).toBeUndefined();
    },
  );

  it.each(["legacy", "native"])(
    "keeps %s lifecycle-dependent models visible but refuses sessionless execution without calling hooks or transport",
    async (kind) => {
      const hook = vi.fn();
      const transport = vi.fn(() => response());
      const fixture = await runtimeFixture((pi) => {
        pi.on("session_start", hook);
        pi.on("before_agent_start", hook);
        if (kind === "legacy") {
          pi.registerProvider(provider, { ...config, streamSimple: transport });
        } else {
          const model: Model<"openai-completions"> = {
            provider,
            id: modelId,
            name: "Native fixture",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 1024,
          };
          pi.registerProvider(
            createProvider({
              id: provider,
              models: [model],
              auth: {
                apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) },
              },
              api: { stream: transport, streamSimple: transport },
            }),
          );
        }
      }, true);
      const model = requireRegisteredModel(fixture.runtime, { provider, modelId });
      expect(await fixture.runtime.getAvailable()).toContainEqual(model);
      expect(fixture.errors[0]).toContain("does not bind Pi session hooks");
      for (const invoke of [
        () => fixture.runtime.streamSimple(model, { messages: [] }),
        () => fixture.runtime.stream(model, { messages: [] }),
        () => fixture.runtime.completeSimple(model, { messages: [] }),
      ])
        expect(invoke).toThrow(/Use a regular Project Session/);
      expect(hook).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("binds separate cwd and prompt captures and preserves Pi tool execution", async () => {
    const captures: { cwd: string; prompt: string; tool: boolean }[] = [];
    const executed: string[] = [];
    const factory: ExtensionFactory = (pi) => {
      let cwd = "";
      let prompt = "";
      let calls = 0;
      pi.on("session_start", (_event, ctx) => {
        cwd = ctx.cwd;
      });
      pi.on("agent_start", (_event, ctx) => {
        prompt = ctx.getSystemPrompt();
      });
      pi.registerTool({
        name: "fixture_tool",
        label: "Fixture",
        description: "Local test only",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          executed.push(ctx.cwd);
          return { content: [{ type: "text", text: "Local tool result" }], details: undefined };
        },
      });
      pi.registerProvider(provider, {
        ...config,
        streamSimple: (_model, context) => {
          captures.push({
            cwd,
            prompt,
            tool: getCurrentTools(context.messages).some((tool) => tool.name === "fixture_tool"),
          });
          expect(getCurrentSystemPrompt(context.messages)).toContain(cwd);
          return calls++ === 0
            ? response(
                [{ type: "toolCall", id: "local-call", name: "fixture_tool", arguments: {} }],
                "toolUse",
              )
            : response([{ type: "text", text: "Finished" }]);
        },
      });
    };
    const a = await runtimeFixture(factory);
    const b = await runtimeFixture(factory);
    const first = await open(a);
    const second = await open(b);
    await first.prompt("Run local tool");
    await second.prompt("Run local tool");
    expect(first.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(second.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(first.messages.filter((message) => message.role === "toolResult")).toEqual([
      expect.objectContaining({ isError: false }),
    ]);
    expect(executed).toEqual([a.cwd, b.cwd]);
    expect(captures.map((entry) => entry.cwd)).toEqual([a.cwd, a.cwd, b.cwd, b.cwd]);
    expect(captures.every((entry) => entry.prompt.includes(entry.cwd) && entry.tool)).toBe(true);
  });

  it.each([false, true])(
    "preserves Cake/project/docs/review instructions when a projecting provider refuses the prompt (forced=%s)",
    async (forced) => {
      let capturedPrompt = "";
      let capturedSections: Record<string, string> = {};
      const fixture = await runtimeFixture(() => {});
      const review = join(fixture.cwd, "reviews.md");
      await writeFile(review, "Review index");
      await writeFile(join(fixture.cwd, "AGENTS.md"), "PROJECT_POLICY_MUST_SURVIVE");
      const capabilities = await createCakeSessionRuntimeCapabilities({
        options: {
          cwd: fixture.cwd,
          agentDir: fixture.agentDir,
          sessionDir: join(fixture.cwd, "sessions"),
          trusted: true,
          newSession: true,
          additionalSystemPrompt: "USER_POLICY_MUST_SURVIVE",
          reviewContextPath: () => review,
          requestUi: async () => undefined,
          onEvent: () => undefined,
        },
        agentDir: fixture.agentDir,
        settingsManager: fixture.settings,
        modelRuntime: fixture.runtime,
        publishSnapshot: async () => undefined,
        requestExtensions: [
          (pi) => {
            pi.on("before_agent_start", (event) => {
              capturedSections = event.systemPromptOptions.sections;
              if (forced)
                return { systemPrompt: `${event.systemPrompt}\nFORCED_POLICY_MUST_SURVIVE` };
              return undefined;
            });
            pi.on("agent_start", (_event, ctx) => {
              capturedPrompt = ctx.getSystemPrompt();
            });
            pi.registerProvider(provider, {
              ...config,
              streamSimple: () => {
                // Local reproduction of the upstream bridge's explicit guard, not a provider call.
                if (
                  capturedSections.docs?.includes("docs/custom-provider.md") &&
                  capturedSections.docs?.includes("docs/packages.md")
                )
                  throw new Error(
                    "Fixture refuses documentation pair; full prompt transport required",
                  );
                throw new Error("Fixture expected preserved documentation");
              },
            });
          },
        ],
      });
      capabilities.setSessionId("fixture-session");
      fixture.loader = capabilities.resourceLoader;
      await registerPendingExtensionProviders(fixture.loader, fixture.runtime);
      const session = await open(fixture);
      await session.prompt("Keep all instructions");
      expect(capturedPrompt).toContain("PROJECT_POLICY_MUST_SURVIVE");
      expect(capturedPrompt).toContain("USER_POLICY_MUST_SURVIVE");
      expect(capturedPrompt).toContain("<cake_system_prompt>");
      expect(capturedSections.cake_reviews).toContain(review);
      expect(capturedPrompt).toContain(review);
      if (forced) expect(capturedPrompt).toContain("FORCED_POLICY_MUST_SURVIVE");
      expect(capturedSections.docs).toContain("docs/custom-provider.md");
      expect(capturedSections.docs).toContain("docs/packages.md");
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "error",
        errorMessage: expect.stringContaining("full prompt transport required"),
      });
    },
  );

  it("passes cancellation to supported provider requests", async () => {
    const started = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const fixture = await runtimeFixture((pi) =>
      pi.registerProvider(provider, {
        ...config,
        streamSimple: (_model, _context, options) => {
          signal = options?.signal;
          const stream = createAssistantMessageEventStream();
          signal?.addEventListener(
            "abort",
            () => {
              void (async () => {
                for await (const event of response([], "aborted")) stream.push(event);
              })();
            },
            { once: true },
          );
          started.resolve();
          return stream;
        },
      }),
    );
    const session = await open(fixture);
    const turn = session.prompt("Wait for cancellation");
    await started.promise;
    await session.abort();
    await turn;
    expect(signal?.aborted).toBe(true);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });
});
