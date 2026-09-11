import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionlessRuntime,
  projectModelCatalog,
} from "../../src/services/pi/live/PiModelsLive";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createAgentDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cake-sessionless-runtime-"));
  directories.push(path);
  await mkdir(join(path, "extensions"), { recursive: true });
  return path;
}

const providerExtension = (id: string) =>
  `export default function (pi) { pi.registerProvider(${JSON.stringify(id)}, ${JSON.stringify({
    name: `${id} provider`,
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "$CAKE_SESSIONLESS_RUNTIME_TEST_KEY",
    api: "openai-completions",
    models: [
      {
        id: `${id}-model`,
        name: `${id} model`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4_096,
        maxTokens: 1_024,
      },
    ],
  })}); }\n`;

describe("createSessionlessRuntime", () => {
  it("includes providers registered by agent-directory extensions", async () => {
    const agentDirectory = await createAgentDirectory();
    await writeFile(
      join(agentDirectory, "extensions", "global-provider.ts"),
      providerExtension("global-fixture"),
    );
    process.env.CAKE_SESSIONLESS_RUNTIME_TEST_KEY = "fixture";
    try {
      const runtime = await createSessionlessRuntime(agentDirectory);
      const catalog = await projectModelCatalog(runtime, getSupportedThinkingLevels);
      const model = catalog.find((entry) => entry.provider === "global-fixture");
      expect(model).toMatchObject({
        id: "global-fixture-model",
        providerName: "global-fixture provider",
        authenticated: true,
        available: true,
      });
    } finally {
      delete process.env.CAKE_SESSIONLESS_RUNTIME_TEST_KEY;
    }
  });

  it("does not load the process cwd's project extensions into the shared catalog", async () => {
    const agentDirectory = await createAgentDirectory();
    const project = await mkdtemp(join(tmpdir(), "cake-sessionless-runtime-project-"));
    directories.push(project);
    await mkdir(join(project, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(project, ".pi", "extensions", "project-provider.ts"),
      providerExtension("project-fixture"),
    );
    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      const runtime = await createSessionlessRuntime(agentDirectory);
      expect(runtime.getProviders().map((provider) => provider.id)).not.toContain(
        "project-fixture",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("falls back to the built-in catalog when an extension fails to load", async () => {
    const agentDirectory = await createAgentDirectory();
    await writeFile(
      join(agentDirectory, "extensions", "broken.ts"),
      `throw new Error("broken on purpose");\n`,
    );
    const runtime = await createSessionlessRuntime(agentDirectory);
    expect(runtime.getProviders().some((provider) => provider.id === "openai")).toBe(true);
  });
});
