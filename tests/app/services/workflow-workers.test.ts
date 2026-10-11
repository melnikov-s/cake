import { it } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Deferred, Effect, Exit, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import {
  WorkflowError,
  WorkflowRunId,
  WorkflowStepId,
  type WorkflowOutputSchema,
  type WorkflowWorkerActivity,
} from "../../../src/contracts/workflows/workflow-data";
import {
  WorkflowWorkers,
  type WorkflowWorkerReference,
  type WorkflowWorkerRequest,
} from "../../../src/services/pi/WorkflowWorkers";
import { createCakeSessionRuntimeCapabilities } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import { makeWorkerFixture, model, usage } from "./fixtures/workflow-worker-runtime";

// Git worktree discovery is external to the resource-selection contract under test.
vi.mock("../../../src/services/pi/runtime/worktree-system-prompt", () => ({
  detectGitWorktree: async () => undefined,
  worktreeSystemPrompt: () => "",
}));

const target = {
  sessionId: "owner",
  runId: WorkflowRunId.make("11111111-1111-4111-8111-111111111111"),
  stepId: WorkflowStepId.make("22222222-2222-4222-8222-222222222222"),
  execution: 1,
};
const request = (overrides: Partial<WorkflowWorkerRequest> = {}): WorkflowWorkerRequest => ({
  target,
  attempt: 1,
  input: { prompt: "Inspect the fixture", options: {} },
  workingDirectory: "/project",
  model,
  commonInstructions: "Common workflow instructions",
  onCreated: () => Effect.void,
  onActivity: () => Effect.void,
  ...overrides,
});
const objectSchema: WorkflowOutputSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
  additionalProperties: false,
};

// Fake only the Pi runtime boundary; retain the worker adapter and its turn handling.
describe("Workflow workers", () => {
  it.effect("loads project context and skills with common and task-specific instructions", () =>
    Effect.gen(function* () {
      const cwd = resolve("tests/app/services/fixtures/workflow-project");
      const fixture = yield* makeWorkerFixture({
        answers: ["done"],
        agentPath: resolve("tests/app/services/fixtures/workflow-user"),
      });
      yield* Effect.gen(function* () {
        const workers = yield* WorkflowWorkers;
        yield* workers.run(
          request({
            workingDirectory: cwd,
            input: { prompt: "Inspect", options: { instructions: "Task-specific instructions" } },
          }),
        );
      }).pipe(Effect.provide(fixture.layer));
      const options = fixture.constructed[0];
      expect(options).toBeDefined();
      if (!options) return;
      const capabilities = yield* Effect.promise(() =>
        createCakeSessionRuntimeCapabilities({
          options,
          agentDir: options.agentDir,
          settingsManager: SettingsManager.inMemory(),
          modelRuntime: { getAvailableOfType: async () => [] },
          requestExtensions: [],
        }),
      );
      const loader = capabilities.resourceLoader;
      expect(
        loader
          .getAgentsFiles()
          .agentsFiles.some((file) => file.content.includes("Workflow fixture project context")),
      ).toBe(true);
      expect(loader.getSkills().skills.some((skill) => skill.name === "workflow-fixture")).toBe(
        true,
      );
      const instructions = loader.getAppendSystemPrompt().join("\n");
      expect(instructions).toContain("Common workflow instructions");
      expect(instructions).toContain("Task-specific instructions");
      expect(instructions).not.toContain("Session Family");
    }),
  );
  it.effect(
    "exposes file tools without Cake controls, message_parent or recursive delegation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeWorkerFixture({ answers: ["done"] });
        yield* Effect.gen(function* () {
          const workers = yield* WorkflowWorkers;
          yield* workers.run(request());
        }).pipe(Effect.provide(fixture.layer));
        const options = fixture.constructed[0];
        expect(options?.tools).toEqual(["read", "bash", "edit", "write"]);
        expect(options?.customTools).toEqual([]);
        expect(options?.auxiliaryProjectResources).toBe(true);
        expect(options?.agentControl).toBeUndefined();
        expect(options?.sessionControl).toBeUndefined();
        expect(options?.currentSessionControl).toBeUndefined();
        expect(options?.isolatedSystemPrompt).toBeUndefined();
        if (!options) return;
        const capabilities = yield* Effect.promise(() =>
          createCakeSessionRuntimeCapabilities({
            options: {
              ...options,
              cwd: resolve("tests/app/services/fixtures/workflow-project"),
              agentDir: resolve("tests/app/services/fixtures/workflow-user"),
            },
            agentDir: resolve("tests/app/services/fixtures/workflow-user"),
            settingsManager: SettingsManager.inMemory(),
            modelRuntime: { getAvailableOfType: async () => [] },
            requestExtensions: [],
          }),
        );
        expect(
          capabilities.resourceLoader
            .getExtensions()
            .extensions.flatMap((extension) => [...extension.tools.keys()]),
        ).toEqual([]);
      }),
  );
  it.effect("inherits the run model and preserves an explicit Cake model selection", () =>
    Effect.gen(function* () {
      const fixture = yield* makeWorkerFixture({ answers: ["done", "done"] });
      const explicit = {
        ...model,
        modelId: "alternate",
        thinkingLevel: "off" as const,
        fastMode: true,
      };
      yield* Effect.gen(function* () {
        const workers = yield* WorkflowWorkers;
        yield* workers.run(request());
        yield* workers.run(
          request({ model: explicit, input: { prompt: "Inspect", options: { model: explicit } } }),
        );
      }).pipe(Effect.provide(fixture.layer));
      expect(fixture.configurations).toEqual([model, explicit]);
    }),
  );
  it.effect("rejects an unavailable explicitly requested model without silent substitution", () =>
    Effect.gen(function* () {
      const fixture = yield* makeWorkerFixture({ unavailable: true });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* WorkflowWorkers)
          .run(request({ model: { ...model, modelId: "alternate" } }))
          .pipe(Effect.result);
      }).pipe(Effect.provide(fixture.layer));
      expect(result._tag).toBe("Failure");
      expect(fixture.constructed).toHaveLength(0);
      expect(fixture.calls.prompts).toBe(0);
    }),
  );
  it.effect(
    "rejects invalid and provably contradictory output schemas before any worker starts",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeWorkerFixture();
        const schemas: WorkflowOutputSchema[] = [
          false,
          { type: "unsupported" },
          { type: "string", minLength: 5, maxLength: 2 },
          { allOf: [{ type: "string" }, { type: "number" }] },
          { type: "object", required: ["x"], additionalProperties: false },
          { type: "number", enum: ["not a number"] },
          { type: "number", minimum: 10, exclusiveMaximum: 10 },
          { type: "integer", minimum: 0.1, maximum: 0.9 },
          { allOf: [{ enum: [1, 2] }, { enum: [3, 4] }] },
        ];
        yield* Effect.gen(function* () {
          const workers = yield* WorkflowWorkers;
          for (const schema of schemas) {
            const result = yield* workers
              .run(request({ input: { prompt: "Inspect", options: { schema } } }))
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
          }
          // Similar constraints on optional types/properties do not prove impossibility.
          yield* workers.validateOutputSchema({ minLength: 5, maxLength: 2 });
          yield* workers.validateOutputSchema({ type: "object", properties: { optional: false } });
          yield* workers.validateOutputSchema({ type: "number", allOf: [{ type: "integer" }] });
          yield* workers.validateOutputSchema({
            type: "object",
            properties: { value: { $ref: "#/definitions/value", enum: [1] } },
            definitions: { value: { type: "integer" } },
          });
        }).pipe(Effect.provide(fixture.layer));
        expect(fixture.constructed).toHaveLength(0);
        expect(fixture.calls.prompts).toBe(0);
      }),
  );
  it.effect("returns only a schema-validated JSON answer when a schema is supplied", () =>
    Effect.gen(function* () {
      const fixture = yield* makeWorkerFixture({ answers: ['{"ok":true}'] });
      const activities: WorkflowWorkerActivity[] = [];
      const result = yield* Effect.gen(function* () {
        return yield* (yield* WorkflowWorkers).run(
          request({
            target: { ...target, execution: 2 },
            attempt: 3,
            input: { prompt: "Inspect", options: { schema: objectSchema } },
            onActivity: (activity) =>
              Effect.sync(() => {
                activities.push(activity);
              }),
          }),
        );
      }).pipe(Effect.provide(fixture.layer));
      expect(result.result).toEqual({ ok: true });
      expect(result.usage).toEqual(usage(1));
      expect(activities.at(-1)).toMatchObject({
        stepId: target.stepId,
        execution: 2,
        attempt: 3,
        streaming: false,
        usage: usage(1),
      });
    }),
  );
  it.effect("retries invalid structured output within the documented five-attempt budget", () =>
    Effect.gen(function* () {
      const success = yield* makeWorkerFixture({
        answers: ["not JSON", "{}", '{"ok":"yes"}', '{"ok":true,"extra":1}', '{"ok":false}'],
      });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* WorkflowWorkers).run(
          request({ input: { prompt: "Inspect", options: { schema: objectSchema } } }),
        );
      }).pipe(Effect.provide(success.layer));
      expect(result.result).toEqual({ ok: false });
      expect(result.usage).toEqual(usage(5));
      expect(success.calls.prompts).toBe(5);
      expect(success.constructed).toHaveLength(1);
      const failure = yield* makeWorkerFixture({
        answers: ["bad", "bad", "bad", "bad", "bad", '{"ok":true}'],
      });
      const exhausted = yield* Effect.gen(function* () {
        return yield* (yield* WorkflowWorkers)
          .run(request({ input: { prompt: "Inspect", options: { schema: objectSchema } } }))
          .pipe(Effect.result);
      }).pipe(Effect.provide(failure.layer));
      expect(exhausted._tag).toBe("Failure");
      expect(failure.calls.prompts).toBe(5);
      expect(failure.calls.releases).toBe(1);
    }),
  );
  it.effect(
    "returns the final assistant text rather than tool text or thinking when no schema is supplied",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeWorkerFixture();
        yield* Effect.gen(function* () {
          const fiber = yield* (yield* WorkflowWorkers).run(request()).pipe(Effect.forkScoped);
          const turn = yield* Queue.take(fixture.started);
          yield* turn.part({
            kind: "reasoning",
            id: "reasoning",
            text: "private thinking",
            status: "complete",
          });
          yield* turn.part({
            kind: "tool",
            id: "tool",
            name: "read",
            input: "file",
            output: "tool text",
            state: "success",
          });
          yield* turn.finish("Final answer");
          expect((yield* Fiber.join(fiber)).result).toBe("Final answer");
        }).pipe(Effect.scoped, Effect.provide(fixture.layer));
      }),
  );
  it.effect(
    "saves the private Pi reference before prompting and retains inspectable history after release",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeWorkerFixture({ answers: ["retained answer"] });
        let reference: WorkflowWorkerReference | undefined;
        yield* Effect.gen(function* () {
          const workers = yield* WorkflowWorkers;
          yield* workers.run(
            request({
              onCreated: (value) =>
                Effect.sync(() => {
                  expect(fixture.calls.prompts).toBe(0);
                  reference = value;
                }),
            }),
          );
          expect(fixture.calls.releases).toBe(1);
          if (!reference) throw new Error("Missing reference");
          const inspected = yield* workers.inspect(reference, target, 1);
          expect(
            inspected.parts.some((part) => part.kind === "text" && part.text === "retained answer"),
          ).toBe(true);
          expect(inspected.streaming).toBe(false);
          expect(fixture.constructed).toHaveLength(1);
        }).pipe(Effect.provide(fixture.layer));
        const rejected = yield* makeWorkerFixture();
        yield* Effect.gen(function* () {
          const result = yield* (yield* WorkflowWorkers)
            .run(
              request({
                onCreated: () =>
                  Effect.fail(
                    new WorkflowError({
                      operation: "checkpoint",
                      reason: "storage",
                      message: "disk full",
                    }),
                  ),
              }),
            )
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }).pipe(Effect.provide(rejected.layer));
        expect(rejected.calls.prompts).toBe(0);
        expect(rejected.calls.releases).toBe(1);
      }),
  );
  it.effect(
    "awaits a long-running turn without the ordinary bounded-subagent five-minute timeout",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeWorkerFixture();
        yield* Effect.gen(function* () {
          const fiber = yield* (yield* WorkflowWorkers).run(request()).pipe(Effect.forkScoped);
          const turn = yield* Queue.take(fixture.started);
          yield* TestClock.adjust(300_001);
          expect(fiber.pollUnsafe()).toBeUndefined();
          // Time waiting for tools is excluded from the ten-minute no-progress window.
          yield* turn.part({
            kind: "tool",
            id: "long-tool",
            name: "bash",
            input: "long task",
            output: "",
            state: "running",
          });
          yield* TestClock.adjust(1_200_000);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* turn.part({
            kind: "tool",
            id: "long-tool",
            name: "bash",
            input: "long task",
            output: "done",
            state: "success",
          });
          yield* turn.finish("long answer");
          expect((yield* Fiber.join(fiber)).result).toBe("long answer");
        }).pipe(Effect.scoped, Effect.provide(fixture.layer));
        // A genuinely idle model still stalls and releases its runtime.
        const stalled = yield* makeWorkerFixture();
        yield* Effect.gen(function* () {
          const fiber = yield* (yield* WorkflowWorkers)
            .run(request({ input: { prompt: "Inspect", options: { stallMs: 100 } } }))
            .pipe(Effect.forkScoped);
          yield* Queue.take(stalled.started);
          yield* TestClock.adjust(101);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(stalled.layer));
        expect(stalled.calls.aborts).toBeGreaterThan(0);
        expect(stalled.calls.releases).toBe(1);
      }),
  );
  it.effect("propagates cancellation through Pi and releases the worker runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeWorkerFixture({ delayedRelease: true });
      yield* Effect.gen(function* () {
        const worker = yield* (yield* WorkflowWorkers).run(request()).pipe(Effect.forkScoped);
        yield* Queue.take(fixture.started);
        const interruption = yield* Fiber.interrupt(worker).pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.releaseStarted);
        expect(fixture.calls.aborts).toBeGreaterThan(0);
        expect(fixture.calls.releases).toBe(0);
        expect(interruption.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(fixture.releaseGate, undefined);
        yield* Fiber.join(interruption);
        expect(fixture.calls.releases).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(fixture.layer));
    }),
  );
  it.effect("inspects the live Pi snapshot while running and retained history after release", () =>
    Effect.gen(function* () {
      const fixture = yield* makeWorkerFixture();
      yield* Effect.gen(function* () {
        const workers = yield* WorkflowWorkers;
        let reference: WorkflowWorkerReference | undefined;
        const worker = yield* workers
          .run(
            request({
              onCreated: (value) =>
                Effect.sync(() => {
                  reference = value;
                }),
            }),
          )
          .pipe(Effect.forkScoped);
        const turn = yield* Queue.take(fixture.started);
        yield* turn.part({
          kind: "text",
          id: "live",
          role: "assistant",
          text: "Live progress",
          status: "streaming",
        });
        if (!reference) throw new Error("Missing worker reference");
        const live = yield* workers.inspect(reference, target, 1);
        expect(live.streaming).toBe(true);
        expect(live.parts).toContainEqual(expect.objectContaining({ text: "Live progress" }));
        expect(fixture.calls.releases).toBe(0);
        yield* turn.finish("Retained final answer");
        yield* Fiber.join(worker);
        const completed = yield* workers.inspect(reference, target, 1);
        expect(completed.streaming).toBe(false);
        expect(completed.parts).toContainEqual(
          expect.objectContaining({ text: "Retained final answer" }),
        );
        expect(fixture.calls.releases).toBe(1);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect("does not enqueue ordinary subagent notifications into the parent conversation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeWorkerFixture({ answers: ["done"] });
      yield* Effect.gen(function* () {
        yield* (yield* WorkflowWorkers).run(request());
      }).pipe(Effect.provide(fixture.layer));
      expect(fixture.calls.notifications).toBe(0);
      expect(fixture.constructed).toHaveLength(1);
    }),
  );
});
