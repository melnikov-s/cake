import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Result } from "effect";
import { expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { modelHandlers } from "../../src/ipc/server/ModelHandlers";
import {
  configureCakeSessionRuntime,
  createCoordinatorRuntime,
  createProjectSessionRuntime,
} from "../../src/layers/CakeOperations";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLive,
} from "../../src/services/pi/CakeSessionRuntimes";
import { makePiModelsLive } from "../../src/services/pi/live/PiModelsLive";
import { makeCakeChatDurableLive } from "../../src/services/pi-durable/CakeChatDurable";
import { makeRuntimeRecoveryStorageTestLayer, options } from "../app/helpers/piRuntimeFixture";

it("refreshes the picker and already-open standard and Durable runtimes from one network pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-model-refresh-"));
  const agentDir = join(directory, "agent");
  const provider = "openai";
  const existing = "gpt-4o";
  const remote = {
    id: "cake-test-refreshed-model",
    name: "Remote fixture model",
    provider,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_024,
  };
  const second = { ...remote, id: "cake-test-second-refresh", name: "Second refresh" };
  let shard = [remote];
  let fail = false;
  let failAnthropic = false;
  let requests = 0;
  let blockNetwork = false;
  const networkStarted = Deferred.makeUnsafe<void>();
  const networkAborted = Deferred.makeUnsafe<void>();
  const constructorLoaded = Deferred.makeUnsafe<void>();
  const finishConstructor = Deferred.makeUnsafe<void>();
  const lateSession = "opening-during-refresh";
  const model = { provider, id: remote.id, authenticated: true };
  const preset = { id: "00000000-0000-4000-8000-000000000001" };
  const configuration = {
    provider,
    modelId: remote.id,
    thinkingLevel: "off" as const,
    fastMode: false,
    preset,
  };
  const context = ManagedRuntime.make(
    Layer.merge(
      makePiModelsLive(agentDir),
      makeCakeSessionRuntimesLive(async (setup) => {
        const runtime = await createProjectSessionRuntime(setup);
        if (setup.sessionId === lateSession) {
          Effect.runSync(Deferred.succeed(constructorLoaded, undefined));
          await Effect.runPromise(Deferred.await(finishConstructor));
        }
        return runtime;
      }).pipe(
        Layer.provide(
          makeCakeChatDurableLive(createCoordinatorRuntime, configureCakeSessionRuntime),
        ),
        Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
      ),
    ),
  );
  try {
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== "https://pi.dev")
        throw new Error(`Unexpected network request: ${url.origin}`);
      if (url.pathname === "/api/models/providers/anthropic" && failAnthropic)
        return Response.json(null);
      if (url.pathname !== "/api/models/providers/openai")
        return new Response(null, { status: 404 });
      requests++;
      if (blockNetwork) {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected a cancellable catalog request");
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              Effect.runSync(Deferred.succeed(networkAborted, undefined));
              reject(signal.reason);
            },
            { once: true },
          );
          Effect.runSync(Deferred.succeed(networkStarted, undefined));
        });
      }
      return fail
        ? Response.json(null)
        : Response.json(shard, { headers: { "last-modified": "Wed, 01 Jan 2098 00:00:00 GMT" } });
    });
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", key: "fixture-key" },
        anthropic: { type: "api_key", key: "fixture-anthropic-key" },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: provider, defaultModel: existing }),
    );
    const location = {
      cwd: directory,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      newSession: true,
    };
    await context.runPromise(
      Effect.gen(function* () {
        const sessions = yield* CakeSessionRuntimes;
        const standard = yield* sessions.acquire(options(location));
        const durable = yield* sessions.acquire({
          profile: { _tag: "CakeChatSession" },
          runtime: {
            ...options(location).runtime,
            sessionId: CAKE_CHAT_SESSION_ID,
            sessionDir: join(directory, "coordinator"),
            globalControl: { tools: [], invoke: async () => ({}) },
            cakeChatMemory: {
              preferences: () => ({ memoryViewBytes: 4_000, instructions: "" }),
              summarize: async () => "",
            },
          },
        });
        expect(yield* modelHandlers["models.list"]()).not.toContainEqual(
          expect.objectContaining(model),
        );
        for (const runtime of [standard, durable]) {
          expect((yield* runtime.snapshot()).models).not.toContainEqual(
            expect.objectContaining(model),
          );
          const unknown = yield* runtime.applyConfiguration(configuration).pipe(Effect.result);
          expect(Result.isFailure(unknown) && unknown.failure.message).toContain(
            `Unknown model ${provider}/${remote.id}`,
          );
        }
        expect(requests).toBe(0);

        yield* modelHandlers["models.refresh"]();
        expect(requests).toBe(1);
        expect(yield* modelHandlers["models.list"]()).toContainEqual(
          expect.objectContaining(model),
        );
        for (const runtime of [standard, durable]) {
          expect((yield* runtime.snapshot()).models).toContainEqual(expect.objectContaining(model));
          yield* runtime.setModel(provider, remote.id);
          expect((yield* runtime.snapshot()).model).toMatchObject({ provider, id: remote.id });
          yield* runtime.setModel(provider, existing);
          // The renderer's preset selection sends this full configuration, including the preset ID.
          yield* runtime.applyConfiguration(configuration);
          expect(yield* runtime.snapshot()).toMatchObject({
            model: { provider, id: remote.id },
            preset,
          });
        }

        fail = true;
        const failed = yield* modelHandlers["models.refresh"]().pipe(Effect.result);
        expect(Result.isFailure(failed) && failed.failure).toMatchObject({
          _tag: "PiModelCatalogError",
          operation: "refresh",
          message: expect.stringContaining(provider),
        });
        // Pi keeps the cached shard on a refresh failure.
        expect(yield* modelHandlers["models.list"]()).toContainEqual(
          expect.objectContaining(model),
        );
        expect(requests).toBe(2);

        fail = false;
        blockNetwork = true;
        const canceled = yield* modelHandlers["models.refresh"]().pipe(Effect.forkScoped);
        yield* Deferred.await(networkStarted);
        yield* Fiber.interrupt(canceled);
        expect(Exit.hasInterrupts(yield* Fiber.await(canceled))).toBe(true);
        yield* Deferred.await(networkAborted);
        expect(requests).toBe(3);
        blockNetwork = false;

        // Let a new session read the old cache, then complete a refresh before its
        // constructor returns to the registry. It must catch up before selection.
        const opening = yield* sessions
          .acquire(options({ ...location, sessionId: lateSession }))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(constructorLoaded);
        shard = [remote, second];
        failAnthropic = true;
        try {
          const partial = yield* modelHandlers["models.refresh"]().pipe(Effect.result);
          expect(Result.isFailure(partial) && partial.failure.message).toContain("anthropic");
          expect(yield* modelHandlers["models.list"]()).toContainEqual(
            expect.objectContaining({ ...model, id: second.id }),
          );
        } finally {
          yield* Deferred.succeed(finishConstructor, undefined);
        }
        expect(requests).toBe(4);
        const late = yield* Fiber.join(opening);
        for (const runtime of [standard, durable, late]) {
          yield* runtime.setModel(provider, second.id);
          expect((yield* runtime.snapshot()).model?.id).toBe(second.id);
        }
      }).pipe(Effect.scoped),
    );
  } finally {
    Effect.runSync(Deferred.succeed(finishConstructor, undefined));
    await context.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
