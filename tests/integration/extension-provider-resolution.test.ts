import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCakeRuntime, type CakeRuntime } from "../../src/services/pi/runtime/cake-runtime";

const directories: string[] = [];
const runtimes: CakeRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A project whose `.pi/extensions` registers a provider, and an agent
 *  directory whose settings default to that provider's model. */
async function createProject() {
  const directory = await mkdtemp(join(tmpdir(), "cake-extension-provider-"));
  directories.push(directory);
  await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(directory, ".pi", "extensions", "fixture-provider.ts"),
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

async function openRuntime(directory: string) {
  const runtime = await createCakeRuntime({
    cwd: directory,
    agentDir: join(directory, "agent"),
    sessionDir: join(directory, "sessions"),
    trusted: true,
    newSession: true,
    requestUi: async () => undefined,
    onEvent: () => undefined,
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
});
