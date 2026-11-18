import {
  configureCakeSessionRuntime,
  createCoordinatorRuntime,
  createProjectSessionRuntime as createCakeSessionRuntime,
} from "../../src/layers/CakeOperations";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import {
  CakeChatDurable,
  makeCakeChatDurableLive,
} from "../../src/services/pi-durable/CakeChatDurable";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  cakeWorkspaceSessionDirectory,
  loadWorkspacePiSessionPreview,
} from "../../src/services/pi/runtime/session-discovery";
import {
  type CakeSessionRuntimeOptions,
  type CakeSessionRuntime,
} from "../../src/services/pi/runtime/cake-session-runtime";

const directories: string[] = [];
const runtimes: CakeSessionRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const choice = {
  provider: "fixture-provider",
  modelId: "fixture-model",
  thinkingLevel: "off",
  fastMode: false,
} as const;
const preset = { ...choice, id: "00000000-0000-4000-8000-000000000001", name: "Fixture" };
const modelPresets = () => ({ presets: [preset], defaultPresetId: preset.id });

/** Pi's imported default is deliberate bait; Cake chooses independently. */
async function createProject(
  extensionHome: "project" | "agent-directory" = "project",
  deferred = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "cake-extension-provider-"));
  directories.push(directory);
  const extensions =
    extensionHome === "project"
      ? join(directory, ".pi", "extensions")
      : join(directory, "agent", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "fixture-provider.ts"),
    `export default function (pi) { ${deferred ? 'pi.on("session_start", () => {' : ""} pi.registerProvider("fixture-provider", ${JSON.stringify(
      {
        name: "Fixture provider",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "fixture",
        api: "openai-completions",
        models: [
          {
            id: "fixture-model",
            name: "Fixture model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 1_024,
          },
        ],
      },
    )}); ${deferred ? "});" : ""} }\n`,
  );
  await mkdir(join(directory, "agent"), { recursive: true });
  await writeFile(
    join(directory, "agent", "settings.json"),
    JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      defaultThinkingLevel: "high",
    }),
  );
  return directory;
}

async function openRuntime(
  directory: string,
  options: { auxiliary?: boolean; cakeChat?: boolean } = {},
  overrides: Partial<CakeSessionRuntimeOptions> = {},
) {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
  const runtimeOptions = {
    cwd: directory,
    agentDir: join(directory, "agent"),
    sessionDir: join(directory, "sessions"),
    newSession: true,
    requestUi: async () => undefined,
    onEvent: () => undefined,
    modelPresets,
    ...overrides,
  };
  const runtime = options.cakeChat
    ? await Effect.runPromise(
        Effect.flatMap(CakeChatDurable, (durable) =>
          durable.createRuntime({
            ...runtimeOptions,
            sessionId: CAKE_CHAT_SESSION_ID,
            sessionDir: join(directory, "global-chat"),
            globalControl: { tools: [], invoke: async () => ({ ok: true }) },
            cakeChatMemory: {
              preferences: () => ({ memoryViewBytes: 4_000, instructions: "" }),
              summarize: async () => "Unused: no turn is submitted",
            },
          }),
        ).pipe(
          Effect.provide(
            makeCakeChatDurableLive(createCoordinatorRuntime, configureCakeSessionRuntime),
          ),
        ),
      )
    : await createCakeSessionRuntime({
        ...runtimeOptions,
        ...(options.auxiliary ? { auxiliary: true, tools: ["read"] } : {}),
      });
  runtimes.push(runtime);
  return runtime;
}

describe("extension provider model resolution", () => {
  it.each([{}, { auxiliary: true }])(
    "does not silently fall back when registration is deferred (%j)",
    async (options) => {
      const directory = await createProject("agent-directory", true);
      vi.stubEnv("OPENAI_API_KEY", "fallback-bait");
      await expect(openRuntime(directory, options)).rejects.toThrow(
        /Selected model fixture-provider\/fixture-model is unavailable.*session_start/,
      );
    },
  );

  it("uses Cake's default preset, not Pi's default model or thinking level, on a fresh Project Session", async () => {
    const directory = await createProject();
    // A built-in provider is authenticated too, so a failed default lookup would
    // have somewhere to fall back to.
    process.env.OPENAI_API_KEY = "fallback-bait";
    try {
      const runtime = await openRuntime(directory);
      const snapshot = await runtime.snapshot();

      expect(snapshot.model).toMatchObject({ provider: "fixture-provider", id: "fixture-model" });
      expect(snapshot.thinkingLevel).toBe("off");
      expect(snapshot.preset?.id).toBe(preset.id);
      expect(snapshot.diagnostics.filter((line) => /Using|Could not restore/.test(line))).toEqual(
        [],
      );
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("honors an explicit Project Session launch even without any preset", async () => {
    const directory = await createProject();
    const runtime = await openRuntime(
      directory,
      {},
      {
        modelPresets: undefined,
        initialConfiguration: choice,
      },
    );
    expect((await runtime.snapshot()).model).toMatchObject({
      provider: choice.provider,
      id: choice.modelId,
    });
  });

  it("does not start a Project Session without a Cake default or explicit choice", async () => {
    const directory = await createProject();
    vi.stubEnv("OPENAI_API_KEY", "fallback-bait");
    await expect(openRuntime(directory, {}, { modelPresets: undefined })).rejects.toThrow(
      /create a preset in Settings/i,
    );
  });

  it.each([false, true])(
    "restores the recorded Project Session choice, never the default (removed=%s)",
    async (removed) => {
      const directory = await createProject();
      vi.stubEnv("OPENAI_API_KEY", "fallback-bait");
      const manager = SessionManager.create(
        directory,
        cakeWorkspaceSessionDirectory(directory, join(directory, "sessions")),
      );
      const saved = removed
        ? { provider: "retired-provider", modelId: "retired-model" }
        : { provider: "openai", modelId: "gpt-4o" };
      manager.appendModelChange(saved.provider, saved.modelId);
      manager.appendThinkingLevelChange("off");
      manager.appendMessage({ role: "user", content: "Saved turn", timestamp: 1 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Saved response" }],
        api: "openai-completions",
        provider: choice.provider,
        model: choice.modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const sessionFile = manager.getSessionFile()!;
      const before = await readFile(sessionFile, "utf8");
      const preview = await loadWorkspacePiSessionPreview(
        directory,
        manager.getSessionId(),
        join(directory, "sessions"),
      );
      expect(preview?.currentModel).toEqual(saved);
      const opened = openRuntime(directory, {}, { newSession: false, sessionFile });
      if (removed)
        await expect(opened).rejects.toThrow(/retired-provider\/retired-model is unavailable/);
      else
        expect((await (await opened).snapshot()).model).toMatchObject({
          provider: saved.provider,
          id: saved.modelId,
        });
      expect(await readFile(sessionFile, "utf8")).toBe(before);
    },
  );

  it("keeps an unregistered Cake Chat preset visible and rejects input without falling back", async () => {
    const directory = await createProject("agent-directory", true);
    vi.stubEnv("OPENAI_API_KEY", "fallback-bait");
    const runtime = await openRuntime(directory, { cakeChat: true });
    expect((await runtime.snapshot()).model).toMatchObject({
      provider: choice.provider,
      id: choice.modelId,
    });
    await expect(runtime.prompt("No fallback", "prompt", [])).rejects.toThrow(
      /Selected model fixture-provider\/fixture-model is unavailable/,
    );
  });

  it("gives a Cake Chat session the agent directory's extension providers", async () => {
    // The Durable coordinator registers agent-directory model providers without
    // binding regular Project Session extension behavior.
    const directory = await createProject("agent-directory");
    process.env.OPENAI_API_KEY = "fallback-bait";
    try {
      const runtime = await openRuntime(directory, { cakeChat: true });
      const snapshot = await runtime.snapshot();

      expect(snapshot.model).toMatchObject({ provider: "fixture-provider", id: "fixture-model" });
      await expect(runtime.setModel("fixture-provider", "fixture-model")).resolves.toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("gives an auxiliary session the agent directory's extension providers", async () => {
    // Side chats and other auxiliary sessions load no extensions of their own.
    const directory = await createProject("agent-directory");
    process.env.OPENAI_API_KEY = "fallback-bait";
    try {
      const runtime = await openRuntime(directory, { auxiliary: true });
      const snapshot = await runtime.snapshot();

      expect(snapshot.model).toMatchObject({ provider: "fixture-provider", id: "fixture-model" });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});
