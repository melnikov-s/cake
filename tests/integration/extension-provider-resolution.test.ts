import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../src/ipc/cake-chat-data";
import {
  CakeChatDurable,
  makeCakeChatDurableLive,
} from "../../src/services/pi-durable/CakeChatDurable";
import {
  createCakeSessionRuntime,
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

/** A project and an agent directory whose settings default to a model on an
 *  extension-registered provider. The extension lives either in the project's
 *  `.pi/extensions` or in the agent directory's `extensions`. */
async function createProject(extensionHome: "project" | "agent-directory" = "project") {
  const directory = await mkdtemp(join(tmpdir(), "cake-extension-provider-"));
  directories.push(directory);
  const extensions =
    extensionHome === "project"
      ? join(directory, ".pi", "extensions")
      : join(directory, "agent", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "fixture-provider.ts"),
    `export default function (pi) { pi.registerProvider("fixture-provider", ${JSON.stringify({
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
    })}); }\n`,
  );
  await mkdir(join(directory, "agent"), { recursive: true });
  await writeFile(
    join(directory, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "fixture-provider", defaultModel: "fixture-model" }),
  );
  return directory;
}

async function openRuntime(
  directory: string,
  options: { auxiliary?: boolean; cakeChat?: boolean } = {},
) {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
  const runtimeOptions = {
    cwd: directory,
    agentDir: join(directory, "agent"),
    sessionDir: join(directory, "sessions"),
    trusted: true,
    newSession: true,
    requestUi: async () => undefined,
    onEvent: () => undefined,
  };
  const runtime = options.cakeChat
    ? await Effect.runPromise(
        Effect.flatMap(CakeChatDurable, (durable) =>
          durable.createRuntime({
            ...runtimeOptions,
            sessionId: CAKE_CHAT_SESSION_ID,
            sessionDir: join(directory, "global-chat", "sessions"),
            globalControl: { tools: [], invoke: async () => ({ ok: true }) },
            cakeChatMemory: {
              preferences: () => ({ memoryViewBytes: 4_000, instructions: "" }),
              summarize: async () => "Unused: no turn is submitted",
            },
          }),
        ).pipe(Effect.provide(makeCakeChatDurableLive())),
      )
    : await createCakeSessionRuntime({
        ...runtimeOptions,
        ...(options.auxiliary ? { auxiliary: true, tools: ["read"] } : {}),
      });
  runtimes.push(runtime);
  return runtime;
}

describe("extension provider model resolution", () => {
  it("honors a settings default that names an extension-registered provider", async () => {
    const directory = await createProject();
    // A built-in provider is authenticated too, so a failed default lookup would
    // have somewhere to fall back to.
    process.env.OPENAI_API_KEY = "fallback-bait";
    try {
      const runtime = await openRuntime(directory);
      const snapshot = await runtime.snapshot();

      expect(snapshot.model).toMatchObject({ provider: "fixture-provider", id: "fixture-model" });
      expect(snapshot.diagnostics.filter((line) => /Using|Could not restore/.test(line))).toEqual(
        [],
      );
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
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
