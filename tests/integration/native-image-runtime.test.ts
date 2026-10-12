import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ImagesOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCakeMcpExtensions } from "../../src/services/pi/runtime/mcp-integration";
import { shutdownCakeSessionExtensions } from "../../src/services/pi/runtime/cake-session-runtime-resources";
import { projectSessionEntries } from "../../src/services/pi/runtime/session-projection";
import { createCakeSessionRuntimeEventProjection } from "../../src/services/pi/runtime/cake-session-runtime-event-projection";
import type { UiPart } from "../../src/contracts/conversations/session-contract";
import {
  imageProviderResponse,
  nativeImageScript,
  originalImageBytes,
} from "../fixtures/native-images";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function openImages(options: { authenticated?: boolean; fetch?: typeof fetch } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-native-images-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  const provider = modelRuntime.getProvider("openrouter");
  if (!provider?.generateImages) throw new Error("Native OpenRouter images implementation missing");
  const requests: { body: unknown; auth: string | null }[] = [];
  const externalFetch: typeof fetch =
    options.fetch ??
    (async (_url, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify(imageProviderResponse()), {
        headers: { "content-type": "application/json" },
      });
    });
  // Fake only the HTTP boundary: real native request encoding, auth, errors and usage.
  modelRuntime.registerNativeProvider({
    ...provider,
    generateImages: (model, context, requestOptions) =>
      provider.generateImages!(model, context, {
        ...requestOptions,
        fetch: externalFetch,
        maxRetries: 0,
      } as ImagesOptions),
  });
  if (options.authenticated !== false)
    await modelRuntime.setRuntimeApiKey("openrouter", "fixture-image-key");
  await modelRuntime.setRuntimeApiKey("openai", "fixture-chat-key");
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: createCakeMcpExtensions({
      runtime: { agentDir },
      loadConfig: () => ({ servers: [], errors: [] }),
    }),
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    model: modelRuntime.getModel("openai", "gpt-4.1-mini"),
  });
  cleanups.push(async () => {
    await session.abort();
    await shutdownCakeSessionExtensions(session);
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });
  expect(session.getActiveToolNames()).toContain("codemode");
  const parts: UiPart[] = [];
  const projection = createCakeSessionRuntimeEventProjection({
    session,
    sessionId: "fixture",
    emit: (event) => {
      if (event.type === "part-updated") parts.push(event.part);
    },
    compactionQueuedMessages: () => [],
    isDisposed: () => false,
  });
  const unsubscribe = session.subscribe(projection.projectEvent);
  cleanups.push(async () => {
    unsubscribe();
    projection.dispose();
  });
  return { session, cwd, requests, parts, projection };
}

function promptScript(session: AgentSession, code: string) {
  const model = session.model!;
  let first = true;
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: first
        ? [{ type: "toolCall", id: "image-script", name: "codemode", arguments: { code } }]
        : [{ type: "text", text: "Image request finished" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: first ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    first = false;
    stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
    stream.end();
    return stream;
  };
  return session.prompt("Generate a fox image using the available native image model");
}

function projectedScript(session: AgentSession) {
  return projectSessionEntries(session.sessionManager.getBranch()).find(
    (part): part is Extract<UiPart, { kind: "tool" }> =>
      part.kind === "tool" && part.name === "codemode",
  )!;
}

describe("native Project Session image generation", () => {
  it("discovers, generates and projects media without writing a workspace file; usage is counted once", async () => {
    const h = await openImages();
    await promptScript(h.session, nativeImageScript());
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.auth).toBe("Bearer fixture-image-key");
    expect(h.requests[0]?.body).toMatchObject({
      model: "google/gemini-2.5-flash-image",
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "A red fox in the snow, watercolor" }] },
      ],
    });
    const script = projectedScript(h.session);
    expect(script.state).toBe("success");
    expect(script.outputContent).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    );
    expect(script.output).not.toContain(originalImageBytes().toString("base64"));
    expect(h.parts).toContainEqual(
      expect.objectContaining({ name: "codemode", outputContent: script.outputContent }),
    );
    expect(await readdir(h.cwd)).toEqual(["agent"]);
    expect(h.projection.currentUsage().tokens).toMatchObject({ input: 17, output: 29, total: 46 });
    const imageModel = h.session.modelRuntime.getModelOfType(
      "image",
      "openrouter",
      "google/gemini-2.5-flash-image",
    )!;
    expect(h.projection.currentUsage().cost).toBeCloseTo(
      (17 * imageModel.cost.input + 29 * imageModel.cost.output) / 1_000_000,
    );
  });

  it("passes a file reference to the native provider and explicitly saves original bytes before preview resizing", async () => {
    const h = await openImages();
    const original = originalImageBytes();
    expect(original.length).toBeGreaterThan(128 * 1024);
    await writeFile(join(h.cwd, "reference's.png"), original);
    await promptScript(
      h.session,
      nativeImageScript({ reference: "reference's.png", save: "fox's original.png" }),
    );
    expect(projectedScript(h.session).state).toBe("success");
    expect(h.requests[0]?.body).toMatchObject({
      messages: [
        {
          content: [
            expect.any(Object),
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${original.toString("base64")}` },
            },
          ],
        },
      ],
    });
    expect(await readFile(join(h.cwd, "fox's original.png"))).toEqual(original);
    expect(await readdir(h.cwd)).toEqual(["agent", "fox's original.png", "reference's.png"]);
    const preview = projectedScript(h.session).outputContent?.find(
      (block) => block.type === "image",
    );
    expect(preview?.type).toBe("image");
    if (preview?.type === "image") expect(preview.data).not.toBe(original.toString("base64"));
    expect(h.projection.currentUsage().tokens.total).toBe(46);
  });

  it("reports save failure and preserves an existing destination instead of claiming success", async () => {
    const h = await openImages();
    await writeFile(join(h.cwd, "fox.png"), "keep existing file");
    await promptScript(h.session, nativeImageScript({ save: "fox.png" }));
    expect(projectedScript(h.session)).toMatchObject({
      state: "error",
      output: expect.stringContaining("EEXIST"),
    });
    expect(await readFile(join(h.cwd, "fox.png"), "utf8")).toBe("keep existing file");
    expect(await readdir(h.cwd)).toEqual(["agent", "fox.png"]);
    // Successful provider work is still charged, even if a later save fails.
    expect(h.projection.currentUsage().tokens.total).toBe(46);
  });

  it("does not treat chat credentials as image credentials", async () => {
    const h = await openImages({ authenticated: false });
    expect(await h.session.modelRuntime.getAvailableOfType("image", "openrouter")).toEqual([]);
    await promptScript(h.session, nativeImageScript({ save: "fox.png" }));
    expect(projectedScript(h.session)).toMatchObject({
      state: "error",
      output: expect.stringContaining("not a ChatGPT subscription"),
    });
    expect(h.requests).toHaveLength(0);
    expect(await readdir(h.cwd)).toEqual(["agent"]);
    expect(h.projection.currentUsage().tokens.total).toBe(0);
  });

  it.each([
    [
      "chat model",
      `await models.generateImages({ provider: "openai", id: "gpt-4.1-mini" }, { input: [{ type: "text", text: "fox" }] });`,
      "not an image model",
    ],
    [
      "invalid input",
      `await models.generateImages({ provider: "openrouter", id: "google/gemini-2.5-flash-image" }, { input: [{ type: "audio", data: "a" }] });`,
      "must be a text or image block",
    ],
  ])("reports unsupported %s rather than generating", async (_label, code, error) => {
    const h = await openImages();
    await promptScript(h.session, code);
    expect(projectedScript(h.session)).toMatchObject({
      state: "error",
      output: expect.stringContaining(error),
    });
    expect(h.requests).toHaveLength(0);
  });

  it("reports provider failure without saving or inventing usage", async () => {
    const h = await openImages({
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "Fixture image failure" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    await promptScript(h.session, nativeImageScript({ save: "fox.png" }));
    expect(projectedScript(h.session)).toMatchObject({
      state: "error",
      output: expect.stringContaining("Fixture image failure"),
    });
    expect(await readdir(h.cwd)).toEqual(["agent"]);
    expect(h.projection.currentUsage().tokens.total).toBe(0);
  });

  it("cancels an in-flight native request without a success image or saved file", async () => {
    let started!: () => void;
    let cancelled!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const h = await openImages({
      fetch: async (_url, init) => {
        started();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(new DOMException("Request aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });
    const prompt = promptScript(h.session, nativeImageScript({ save: "fox.png" }));
    await start;
    await h.session.abort();
    await prompt;
    await cancellation;
    expect(projectedScript(h.session).state).not.toBe("success");
    expect(
      projectedScript(h.session).outputContent?.some((block) => block.type === "image"),
    ).not.toBe(true);
    expect(await readdir(h.cwd)).toEqual(["agent"]);
    expect(h.projection.currentUsage().tokens.total).toBe(0);
  });
});
