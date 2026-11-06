import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import {
  ArtifactRuntimeError,
  type ArtifactRuntimeTarget,
} from "../../../src/contracts/artifacts/artifact-runtime";
import { ArtifactRuntimeDescriptor } from "../../../src/contracts/artifacts/artifact-runtime-descriptor";
import type { ArtifactState } from "../../../src/contracts/artifacts/artifact-state";
import {
  ArtifactRuntime,
  type ArtifactRuntimeHost,
} from "../../../src/services/artifact-runtime/ArtifactRuntime";
import { ArtifactRuntimeLive } from "../../../src/services/artifact-runtime/ArtifactRuntimeLive";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";

const lineageId = decodeArtifactLineageId("pr-dashboard");
const objectInput = { type: "object", additionalProperties: false };
const source = `
let refreshCount = 0;
return {
  lifecycle: {
    start: () => cake("test.lifecycle", { event: "start" }),
    focus: () => cake("test.lifecycle", { event: "focus" }),
    blur: () => cake("test.lifecycle", { event: "blur" }),
    unmount: () => cake("test.lifecycle", { event: "unmount" }),
    stop: () => cake("test.lifecycle", { event: "stop" }),
    delete: () => cake("test.lifecycle", { event: "delete" }),
  },
  tools: {
    refresh: async ({ repo }) => {
      const response = await cake("network.request", { url: "https://example.test/prs/" + repo });
      await data.write(response);
      refreshCount += 1;
      return { refreshCount, count: response.prs.length };
    },
    readiness: async () => {
      const stored = await data.read();
      const prs = stored?.prs ?? [];
      return { ready: prs.filter(pr => pr.checks === "passing" && pr.reviews > 0).map(pr => pr.id),
        blocked: prs.filter(pr => pr.checks !== "passing" || pr.reviews === 0).map(pr => pr.id) };
    },
    sendToChat: async ({ sessionId }) => {
      const stored = await data.read();
      await cake("chat.prompt", { sessionId, text: JSON.stringify(stored) });
      return { sent: true };
    },
    capabilities: () => [typeof process, typeof require, typeof fetch, typeof document, typeof setTimeout],
    badOutput: () => "not an integer",
  },
};`;
const runtime = Schema.decodeUnknownSync(ArtifactRuntimeDescriptor)({
  source,
  tools: [
    {
      name: "refresh",
      description: "Refresh pull requests for a repository",
      inputSchema: { ...objectInput, properties: { repo: { type: "string" } }, required: ["repo"] },
      outputSchema: { type: "object", required: ["count", "refreshCount"] },
    },
    {
      name: "readiness",
      description: "Find ready and blocked pull requests",
      inputSchema: objectInput,
      outputSchema: { type: "object", required: ["ready", "blocked"] },
    },
    {
      name: "sendToChat",
      description: "Send the current dashboard to a chosen chat",
      inputSchema: {
        ...objectInput,
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      outputSchema: { type: "object", required: ["sent"] },
    },
    {
      name: "capabilities",
      description: "Inspect available native globals",
      inputSchema: objectInput,
      outputSchema: { type: "array" },
    },
    {
      name: "badOutput",
      description: "An invalid implementation for boundary testing",
      inputSchema: objectInput,
      outputSchema: { type: "integer" },
    },
  ],
});
const target: ArtifactRuntimeTarget = { lineageId, revision: 1, runtime };

function fixture(hostOverride?: ArtifactRuntimeHost) {
  let state: ArtifactState = { lineageId, version: 0, value: null };
  const commands: Array<{ command: string; input: Schema.Json; callingSessionId?: string }> = [];
  let invalidations = 0;
  const host: ArtifactRuntimeHost = hostOverride ?? {
    invokeCommand: (request) =>
      Effect.sync((): Schema.Json => {
        commands.push(request);
        if (request.command === "network.request")
          return {
            prs: [
              { id: 12, checks: "passing", reviews: 2 },
              { id: 13, checks: "failing", reviews: 1 },
            ],
          };
        return { ok: true };
      }),
  };
  const storage = Layer.mock(ArtifactStorage, {
    readState: () => Effect.succeed(state),
    replaceState: (input) =>
      Effect.sync(() => {
        expect(input.expectedVersion).toBe(state.version);
        state = { lineageId, version: state.version + 1, value: input.value };
        return state;
      }),
  });
  const clients = Layer.mock(ClientEvents, {
    sendTo: () => false,
    broadcast: (event) => {
      if (event.type === "artifact-state-invalidated") invalidations += 1;
    },
  });
  const layer = ArtifactRuntimeLive.pipe(Layer.provide(Layer.merge(storage, clients)));
  return { layer, host, commands, invalidations: () => invalidations };
}

describe("Independent artifact runtime", () => {
  it.effect(
    "refreshes a PR dashboard while closed, answers readiness and sends to an explicit chat without a fake caller",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ArtifactRuntime;
        yield* service.setHost(f.host);
        expect((yield* service.listTools(target)).map((tool) => tool.name)).toContain("readiness");
        expect(f.commands).toEqual([]);
        expect((yield* service.status(lineageId)).running).toBe(false);
        expect(yield* service.call({ target, name: "refresh", input: { repo: "cake" } })).toEqual({
          refreshCount: 1,
          count: 2,
        });
        yield* service.lifecycle({ target, event: "focus", viewId: "main" });
        yield* service.lifecycle({ target, event: "blur", viewId: "main" });
        yield* service.lifecycle({ target, event: "unmount", viewId: "main" });
        expect((yield* service.status(lineageId)).running).toBe(true);
        expect(yield* service.call({ target, name: "readiness", input: {} })).toEqual({
          ready: [12],
          blocked: [13],
        });
        expect(yield* service.call({ target, name: "refresh", input: { repo: "cake" } })).toEqual({
          refreshCount: 2,
          count: 2,
        });
        expect(
          yield* service.call({
            target,
            name: "sendToChat",
            input: { sessionId: "chosen-chat" },
            callingSessionId: "actual-caller",
          }),
        ).toEqual({ sent: true });
        expect(
          f.commands
            .filter((c) => c.command === "network.request")
            .every((c) => c.callingSessionId === undefined),
        ).toBe(true);
        expect(f.commands.find((c) => c.command === "chat.prompt")).toMatchObject({
          callingSessionId: "actual-caller",
          input: { sessionId: "chosen-chat" },
        });
        expect(
          f.commands.filter((c) => c.command === "test.lifecycle").map((c) => c.input),
        ).toEqual([
          { event: "start" },
          { event: "focus" },
          { event: "blur" },
          { event: "unmount" },
        ]);
        expect(f.invalidations()).toBe(2);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("restarts and reloads revised source while retaining artifact-scoped data", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* ArtifactRuntime;
      yield* service.setHost(f.host);
      yield* service.call({ target, name: "refresh", input: { repo: "cake" } });
      yield* service.stop(lineageId);
      expect((yield* service.status(lineageId)).running).toBe(false);
      const commandsAfterStop = f.commands.length;
      yield* service.lifecycle({ target, event: "unmount" });
      expect(f.commands).toHaveLength(commandsAfterStop);
      expect((yield* service.status(lineageId)).running).toBe(false);
      expect(yield* service.call({ target, name: "readiness", input: {} })).toEqual({
        ready: [12],
        blocked: [13],
      });
      expect(yield* service.call({ target, name: "refresh", input: { repo: "cake" } })).toEqual({
        refreshCount: 1,
        count: 2,
      });
      const revised = {
        ...target,
        revision: 2,
        runtime: {
          ...runtime,
          source: source.replace("let refreshCount = 0", "let refreshCount = 100"),
        },
      };
      expect(
        yield* service.call({ target: revised, name: "refresh", input: { repo: "cake" } }),
      ).toEqual({ refreshCount: 101, count: 2 });
      expect((yield* service.status(lineageId)).revision).toBe(2);
      yield* service.stop(lineageId, "delete");
      expect(f.commands.at(-1)?.input).toEqual({ event: "delete" });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("validates typed input/output, exposes failures and isolates backend globals", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* ArtifactRuntime;
      yield* service.setHost(f.host);
      const invalid = yield* service
        .call({ target, name: "refresh", input: { repo: 123 } })
        .pipe(Effect.flip);
      expect(invalid.operation).toBe("input");
      expect(f.commands).toHaveLength(0);
      expect((yield* service.status(lineageId)).lastError).toContain("string");
      expect(
        (yield* service.call({ target, name: "badOutput", input: {} }).pipe(Effect.flip)).operation,
      ).toBe("output");
      expect(yield* service.call({ target, name: "capabilities", input: {} })).toEqual(
        Array(5).fill("undefined"),
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "does not start absent runtimes for inspection, late blur/unmount or stop; reports startup failures",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ArtifactRuntime;
        yield* service.setHost(f.host);
        yield* service.listTools(target);
        yield* service.lifecycle({ target, event: "blur" });
        yield* service.lifecycle({ target, event: "unmount" });
        yield* service.stop(lineageId);
        expect(f.commands).toEqual([]);
        const broken = {
          ...target,
          runtime: { ...runtime, source: "throw new Error('failed to start')" },
        };
        expect(
          (yield* service.lifecycle({ target: broken, event: "start" }).pipe(Effect.flip)).message,
        ).toContain("failed to start");
        expect(yield* service.status(lineageId)).toMatchObject({
          running: false,
          lastError: expect.stringContaining("failed to start"),
        });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "finishes an in-flight call on its captured revision before the next call reloads",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const f = fixture({
          invokeCommand: ({ command }) =>
            command === "test.wait"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(null),
                )
              : Effect.succeed(null),
        });
        yield* Effect.gen(function* () {
          const service = yield* ArtifactRuntime;
          yield* service.setHost(f.host);
          const waiting = {
            ...target,
            runtime: {
              source:
                "return { tools: { value: async () => { await cake('test.wait'); return 1; } } };",
              tools: [
                {
                  name: "value",
                  description: "Read revision value",
                  inputSchema: true,
                  outputSchema: { type: "integer" },
                },
              ],
            },
          };
          const first = yield* service
            .call({ target: waiting, name: "value", input: {} })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const revised = {
            ...waiting,
            revision: 2,
            runtime: { ...waiting.runtime, source: "return { tools: { value: () => 2 } };" },
          };
          const second = yield* service
            .call({ target: revised, name: "value", input: {} })
            .pipe(Effect.forkScoped);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(first)).toBe(1);
          expect(yield* Fiber.join(second)).toBe(2);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "rejects invalid JSON schemas and undeclared tool calls without starting side effects",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* ArtifactRuntime;
        yield* service.setHost(f.host);
        const invalidSchema = {
          ...target,
          runtime: {
            ...runtime,
            tools: [
              {
                name: "bad",
                description: "Invalid schema",
                inputSchema: { type: "not-a-type" },
                outputSchema: true,
              },
            ],
          },
        };
        expect((yield* service.listTools(invalidSchema).pipe(Effect.flip)).operation).toBe(
          "definitions",
        );
        expect(
          (yield* service.call({ target, name: "undeclared", input: {} }).pipe(Effect.flip))
            .operation,
        ).toBe("call");
        expect(f.commands).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("keeps data across backend runtime disposal and reacquisition", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* ArtifactRuntime;
        yield* service.setHost(f.host);
        yield* service.call({ target, name: "refresh", input: { repo: "cake" } });
      }).pipe(Effect.provide(f.layer));
      yield* Effect.gen(function* () {
        const service = yield* ArtifactRuntime;
        yield* service.setHost(f.host);
        expect((yield* service.status(lineageId)).running).toBe(false);
        expect(yield* service.call({ target, name: "readiness", input: {} })).toEqual({
          ready: [12],
          blocked: [13],
        });
      }).pipe(Effect.provide(f.layer));
    });
  });

  it.effect("fails canonical bridge calls truthfully until composition binds the host", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* ArtifactRuntime;
      const error = yield* service.lifecycle({ target, event: "start" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ArtifactRuntimeError);
      expect(error.message).toContain("not bound");
      yield* service.setHost(f.host);
      yield* service.lifecycle({ target, event: "start" });
      expect((yield* service.status(lineageId)).lastError).toBe(null);
    }).pipe(Effect.provide(f.layer));
  });
});
