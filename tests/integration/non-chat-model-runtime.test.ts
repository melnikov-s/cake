import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { AgentSettingsInvocation } from "../../src/ipc/agent-settings-schema";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { PiSettings } from "../../src/services/pi/PiSettings";
import { makePiSettingsLive } from "../../src/services/pi/live/PiSettingsLive";
import {
  createCakeSessionRuntime,
  type CakeSessionRuntime,
} from "../../src/services/pi/runtime/cake-session-runtime";
import {
  createSessionlessRuntime,
  projectModelCatalog,
  projectNonChatModelCatalog,
} from "../../src/services/pi/live/PiModelsLive";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { NonChatModelPreferences } from "../../src/contracts/models/non-chat-model-data";
import { nativeNonChatScript, nonChatProviderSource } from "../fixtures/non-chat-provider";

const directories: string[] = [];
const runtimes: CakeSessionRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "cake-non-chat-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  const trace = join(cwd, "calls.jsonl");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(trace, "");
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ "non-chat-fixture": { type: "api_key", key: "fixture" } }),
  );
  await writeFile(join(agentDir, "extensions", "provider.ts"), nonChatProviderSource(trace));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "non-chat-fixture",
      defaultModel: "chat",
      defaultTools: ["+codemode"],
    }),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  return { cwd, agentDir, trace };
}
const reference = (modelId: string) => ({ provider: "non-chat-fixture", modelId });

describe("Native non-chat model settings contract", () => {
  it("persists native execution settings on the backend and activates eligible codemode through reload", async () => {
    const h = await setup();
    await writeFile(
      join(h.agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "non-chat-fixture",
        defaultModel: "chat",
        defaultTools: ["-bash", "+grep"],
        codemode: { mode: "only", inlineBudget: 4000 },
        unrelated: { keep: true },
      }),
    );
    const options = {
      ...h,
      trusted: true,
      sessionDir: join(h.cwd, "sessions"),
      newSession: true,
      requestUi: async () => undefined,
      onEvent: () => {},
    };
    const runtime = await createCakeSessionRuntime(options);
    runtimes.push(runtime);
    expect((await runtime.snapshot()).model).toMatchObject({
      provider: "non-chat-fixture",
      id: "chat",
    });
    const script =
      'SCRIPT:const m = await models.getModelOfType("image","non-chat-fixture","image-a"); return await models.generateImages(m,{input:[{type:"text",text:"fixture"}]});';
    await runtime.prompt(script, "prompt", []);
    expect(await readFile(h.trace, "utf8")).toBe("");
    const layer = makePiSettingsLive(h.agentDir).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    );
    const update = (
      key: "defaultTools" | "codemodeInlineBudget",
      value: string[] | number | null,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const settings = yield* PiSettings;
          if (key === "defaultTools" && (Array.isArray(value) || value === null))
            return yield* settings.update({ key, value });
          if (key === "codemodeInlineBudget" && typeof value === "number")
            return yield* settings.update({ key, value });
          throw new Error("Invalid fixture update");
        }).pipe(Effect.provide(layer)),
      );
    await update("defaultTools", ["-bash", "+grep", "+codemode"]);
    await update("codemodeInlineBudget", 0);
    await runtime.reload?.();
    await runtime.prompt(script, "prompt", []);
    expect(await readFile(h.trace, "utf8")).toContain('"model":"image-a"');
    const stored = JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8"));
    expect(stored).toMatchObject({
      defaultTools: ["-bash", "+grep", "+codemode"],
      codemode: { mode: "only", inlineBudget: 0 },
      unrelated: { keep: true },
    });
    expect(stored).not.toHaveProperty("tools");
    await update("defaultTools", []);
    await runtime.reload?.();
    // Pi documents reload as additive: removing tools applies to a fresh runtime.
    await runtime.prompt(script, "prompt", []);
    const previousCalls = await readFile(h.trace, "utf8");
    expect(previousCalls.trim().split("\n")).toHaveLength(2);
    const fresh = await createCakeSessionRuntime(options);
    runtimes.push(fresh);
    expect((await fresh.snapshot()).model).toMatchObject({
      provider: "non-chat-fixture",
      id: "chat",
    });
    await fresh.prompt(script, "prompt", []);
    expect(await readFile(h.trace, "utf8")).toBe(previousCalls);
    await update("defaultTools", null);
    expect(
      JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8")),
    ).not.toHaveProperty("defaultTools");
  });

  it("projects native known/available models and non-chat-only providers without contaminating chat models", async () => {
    const h = await setup();
    const runtime = await createSessionlessRuntime(h.agentDir);
    const catalog = await projectNonChatModelCatalog(runtime);
    expect(catalog.filter((model) => model.provider === "non-chat-fixture")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          id: "image-a",
          authenticated: true,
          available: true,
          authLabel: "fixture credential",
        }),
        expect.objectContaining({
          type: "classifier",
          id: "classifier-a",
          authenticated: true,
          available: true,
        }),
      ]),
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({
        provider: "typesafe",
        type: "classifier",
        id: "jev-latest",
        authTypes: ["api_key"],
      }),
    );
    const chat = await projectModelCatalog(runtime, getSupportedThinkingLevels);
    expect(
      chat.filter((model) => model.provider === "non-chat-fixture").map((model) => model.id),
    ).toEqual(["chat"]);
    expect(chat.some((model) => model.provider === "typesafe")).toBe(false);
    const prompts: string[] = [];
    await runtime.login("typesafe", "api_key", {
      prompt: async (prompt) => {
        prompts.push(prompt.type);
        return "non-chat-fixture-key";
      },
      notify: () => {},
    });
    expect(prompts).toEqual(["secret"]);
    const authenticated = await projectNonChatModelCatalog(runtime);
    expect(authenticated).toContainEqual(
      expect.objectContaining({
        provider: "typesafe",
        type: "classifier",
        authenticated: true,
        available: true,
        authSource: "stored",
      }),
    );
    const reloaded = await createSessionlessRuntime(h.agentDir);
    expect(await projectNonChatModelCatalog(reloaded)).toContainEqual(
      expect.objectContaining({ provider: "typesafe", authenticated: true, authSource: "stored" }),
    );
    expect(
      (await projectModelCatalog(reloaded, getSupportedThinkingLevels)).some(
        (model) => model.provider === "typesafe",
      ),
    ).toBe(false);
  });

  it("passes latest backend preferences and explicit overrides to real native fake image/classifier codemode calls", async () => {
    const h = await setup();
    let preferences: NonChatModelPreferences = {
      image: reference("image-a"),
      classifier: reference("classifier-a"),
    };
    const runtime = await createCakeSessionRuntime({
      ...h,
      trusted: true,
      sessionDir: join(h.cwd, "sessions"),
      newSession: true,
      requestUi: async () => undefined,
      onEvent: () => {},
      nonChatModelPreferences: () => preferences,
      currentSessionControl: {
        resolved: () => false,
        setResolved: async () => {},
        readPolicy: async () => ({ canFork: true, deferResolution: true }),
        resolveDeferredStandalone: async () => {},
        invokeAppControl: async (command, input, signal) => {
          signal.throwIfAborted();
          const invocation = await Schema.decodeUnknownPromise(AgentSettingsInvocation)(
            { name: command, arguments: input },
            { onExcessProperty: "error" },
          );
          if (invocation.name !== "settings.models.set-non-chat")
            throw new Error("Unexpected fixture operation");
          const { type, preference } = invocation.arguments;
          const next = { ...preferences };
          if (preference === null) delete next[type];
          else next[type] = preference;
          preferences = next;
          return { ok: true, command, value: preferences };
        },
      },
    });
    runtimes.push(runtime);
    expect((await runtime.snapshot()).model).toMatchObject({
      provider: "non-chat-fixture",
      id: "chat",
    });
    await runtime.prompt(`SCRIPT:${nativeNonChatScript("image")}`, "prompt", []);
    await runtime.prompt(`SCRIPT:${nativeNonChatScript("classifier")}`, "prompt", []);
    await runtime.prompt(`SCRIPT:${nativeNonChatScript("image", "image-b")}`, "prompt", []);
    // Native codemode consumes a real structured settings operation before selecting a model.
    await runtime.prompt(
      `SCRIPT:const saved = await tools.cake({command:"settings.models.set-non-chat", input:{type:"classifier", preference:{provider:"non-chat-fixture", modelId:"classifier-b"}}}); if (!saved.result.ok) throw new Error("Settings failed"); ${nativeNonChatScript("classifier")}`,
      "prompt",
      [],
    );
    const rawCalls = await readFile(h.trace, "utf8");
    expect(rawCalls, JSON.stringify(await runtime.snapshot())).not.toBe("");
    const calls = rawCalls
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map(({ type, model }) => ({ type, model }))).toEqual([
      { type: "image", model: "image-a" },
      { type: "classifier", model: "classifier-a" },
      { type: "image", model: "image-b" },
      { type: "classifier", model: "classifier-b" },
    ]);
    const traceBefore = await readFile(h.trace, "utf8");
    preferences = {};
    await runtime.prompt(`SCRIPT:${nativeNonChatScript("image")}`, "prompt", []);
    expect(JSON.stringify(await runtime.snapshot())).toContain("agent");
    expect(await readFile(h.trace, "utf8")).toBe(traceBefore);
    preferences = { image: reference("missing-image") };
    await runtime.prompt(`SCRIPT:${nativeNonChatScript("image")}`, "prompt", []);
    expect(JSON.stringify(await runtime.snapshot())).toContain("no substitution was made");
    expect(await readFile(h.trace, "utf8")).toBe(traceBefore);
    await runtime.prompt(`SCRIPT:${nativeNonChatScript("image", "image-a")}`, "prompt", []);
    const finalCalls = (await readFile(h.trace, "utf8")).trim().split("\n");
    expect(finalCalls).toHaveLength(5);
    expect(JSON.parse(finalCalls.at(-1) ?? "null")).toMatchObject({
      type: "image",
      model: "image-a",
    });
    const restricted = await createCakeSessionRuntime({
      ...h,
      trusted: true,
      sessionDir: join(h.cwd, "restricted"),
      newSession: true,
      auxiliary: true,
      tools: ["read"],
      requestUi: async () => undefined,
      onEvent: () => {},
      currentSessionControl: {
        resolved: () => false,
        setResolved: async () => {},
        readPolicy: async () => ({ canFork: true, deferResolution: true }),
        resolveDeferredStandalone: async () => {},
        invokeAppControl: async () => {
          throw new Error("Restricted settings must not dispatch");
        },
      },
    });
    runtimes.push(restricted);
    expect((await restricted.snapshot()).model).toMatchObject({
      provider: "non-chat-fixture",
      id: "chat",
    });
    expect(
      JSON.stringify(
        await restricted.callCakeOperation?.(
          "settings.pi.update",
          { key: "defaultTools", value: ["+codemode"] },
          new AbortController().signal,
        ),
      ),
    ).toContain("Unknown Cake command");
  }, 30_000);

  it("cancels an in-flight native image request without reporting success", async () => {
    const h = await setup();
    const runtime = await createCakeSessionRuntime({
      ...h,
      trusted: true,
      sessionDir: join(h.cwd, "sessions"),
      newSession: true,
      requestUi: async () => undefined,
      onEvent: () => {},
      nonChatModelPreferences: () => ({ image: reference("image-a") }),
    });
    runtimes.push(runtime);
    expect((await runtime.snapshot()).model).toMatchObject({
      provider: "non-chat-fixture",
      id: "chat",
    });
    let ready: () => void = () => {};
    let failed: (cause: unknown) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const watcher = watch(h.trace, () => {
      void readFile(h.trace, "utf8").then((content) => {
        if (content.includes('"text":"wait"')) ready();
      }, failed);
    });
    try {
      const prompt = runtime.prompt(
        'SCRIPT:const {result: selected} = await tools.cake({command:"models.select-non-chat",input:{type:"image"}}); const r = await models.generateImages(selected.model,{input:[{type:"text",text:"wait"}]}); return r.stopReason;',
        "prompt",
        [],
      );
      await Promise.race([
        started,
        prompt.then(() => {
          throw new Error("Native image request finished before it started");
        }),
      ]);
      await runtime.abort();
      await prompt;
      expect(await readFile(h.trace, "utf8")).toContain("cancelled");
      expect(JSON.stringify(await runtime.snapshot())).not.toContain("Script completed");
    } finally {
      watcher.close();
    }
  }, 30_000);
});
