import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { ConfigProvider, Deferred, Effect, Fiber, FiberMap, Queue, Ref, Stream } from "effect";
import * as workflows from "../../../src/domain/workflows/workflows";
import { WorkflowSupervisor } from "../../../src/services/workflows/WorkflowSupervisor";
import {
  WorkflowRunStorage,
  type WorkflowCheckpoint,
} from "../../../src/services/storage/WorkflowRunStorage";
import { WorkflowError } from "../../../src/contracts/workflows/workflow-data";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { hasActive, holdsCompletion } from "../../../src/domain/workflows/workflow-lifecycle";
import { makeWorkflowDomainFixture } from "../helpers/workflowDomainFixture";
import { checkpoint, target } from "../helpers/workflowFixture";
const launchInput = { sessionId: target.sessionId, scriptPath: "/project/workflow.js" };
const drain = Effect.gen(function* () {
  const supervisor = yield* WorkflowSupervisor;
  yield* FiberMap.awaitEmpty(supervisor.runs);
  yield* FiberMap.awaitEmpty(supervisor.reports);
});

// Contract-first skeleton: implementation will exercise real domain Effects with
// fake Sandbox, Workers and Storage boundaries and Deferred/Queue synchronization.
describe("Dynamic workflow lifecycle", () => {
  it.effect(
    "disabling the experiment blocks new runs without cancelling accepted work or removing its controls",
    () =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
          worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const receipt = yield* workflows.start(launchInput);
          yield* Queue.take(f.assignments);
          yield* f.application.transact((state) =>
            Effect.succeed({ ...state, experimentalFeatures: { dynamicWorkflows: false } }),
          );
          expect((yield* workflows.inspect(receipt)).steps[0]?.status).toBe("running");
          expect((yield* Effect.result(workflows.start(launchInput)))._tag).toBe("Failure");
          yield* workflows.pause(receipt);
          yield* workflows.resume(receipt);
          yield* workflows.stop(receipt);
          yield* drain;
          expect((yield* workflows.inspect(receipt)).status).toBe("stopped");
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect("persists a launch and returns a handle without waiting for the first worker", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        expect(receipt.status).toBe("running");
        yield* Queue.take(f.assignments);
        expect((yield* workflows.inspect(receipt)).steps[0]?.status).toBe("running");
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).status).toBe("complete");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("runs omitted-model agents with the start-time default preset, not the caller's", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({
        run: (host) =>
          host
            .agent({ prompt: "first", options: {} }, "throw")
            .pipe(Effect.andThen(host.agent({ prompt: "second", options: {} }, "throw"))),
      });
      const preset = (id: string, modelId: string, fastMode: boolean) => ({
        id,
        name: modelId,
        provider: "configured",
        modelId,
        thinkingLevel: "medium" as const,
        fastMode,
      });
      const first = preset("00000000-0000-4000-8000-000000000301", "default-a", true);
      const second = preset("00000000-0000-4000-8000-000000000302", "default-b", false);
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        yield* f.application.transact((state) =>
          Effect.succeed({
            ...state,
            modelPresets: [first, second],
            defaultModelPresetId: first.id,
          }),
        );
        yield* workflows.start(launchInput);
        const firstRequest = yield* Queue.take(f.assignments);
        // A later default change does not switch an accepted run.
        yield* f.application.transact((state) =>
          Effect.succeed({ ...state, defaultModelPresetId: second.id }),
        );
        const secondRequest = yield* Queue.take(f.assignments);
        const expected = {
          provider: "configured",
          modelId: "default-a",
          preset: { id: first.id },
          thinkingLevel: "medium",
          fastMode: true,
        };
        expect(firstRequest.model).toEqual(expected);
        expect(secondRequest.model).toEqual(expected);
        yield* drain;
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("rejects Cake Chat and Discussion Session identities as execution owners", () =>
    Effect.gen(function* () {
      for (const profile of ["CakeChatSession", "DiscussionSession"] as const) {
        const f = yield* makeWorkflowDomainFixture({ run: () => Effect.succeed(null), profile });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          expect((yield* Effect.result(workflows.start(launchInput)))._tag).toBe("Failure");
        }).pipe(Effect.provide(f.layer));
      }
    }),
  );
  it.effect("continues accepted work after the launching turn and observing window end", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        yield* Stream.runHead(yield* workflows.observe({ sessionId: receipt.sessionId }));
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).status).toBe("complete");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect(
    "routes intermediate answers only to the script and delivers one consolidated report",
    () =>
      Effect.gen(function* () {
        const f = yield* makeWorkflowDomainFixture({
          run: (host) =>
            Effect.gen(function* () {
              const a = yield* host.agent({ prompt: "first", options: {} }, "throw");
              const b = yield* host.agent({ prompt: "second", options: {} }, "throw");
              return `Combined: ${a}, ${b}`;
            }),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          yield* workflows.start(launchInput);
          yield* drain;
          expect(yield* Queue.take(f.reports)).toContain("Combined: first, second");
          expect(yield* Queue.size(f.reports)).toBe(0);
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect("defers spawned-task completion reporting until its owned workflow finishes", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "Actual audit findings" })),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const journal = yield* SessionFamilyStorage;
        yield* journal.recordTurn({
          turnId: "assignment",
          sessionId: "session-1",
          senderSessionId: "parent",
          requestMessageId: "request",
          threadId: "thread",
          reported: false,
        });
        f.executing.push("assignment");
        const receipt = yield* workflows.start(launchInput, launchInput.sessionId);
        yield* Queue.take(f.assignments);
        expect(yield* holdsCompletion(receipt.sessionId)).toBe(true);
        f.executing.length = 0;
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
        expect(yield* holdsCompletion(receipt.sessionId)).toBe(false);
        expect(
          (yield* journal.state()).turns.find((turn) => turn.turnId === "assignment")?.report?.text,
        ).toBe("Actual audit findings");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("freezes the program and arguments despite later edits to its source file", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: () => Deferred.await(finish).pipe(Effect.as("done")),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start({ ...launchInput, args: { question: "original" } });
        const frozen = yield* Queue.take(f.programs);
        f.scripts.set(launchInput.scriptPath, { ...checkpoint().run.program, source: "changed" });
        expect(frozen.source).toContain("return args");
        expect(frozen.args).toEqual({ question: "original" });
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).program.source).toBe(frozen.source);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("publishes a coherent catalog snapshot before ordered run changes", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const changes = yield* Queue.unbounded<string>();
      const f = yield* makeWorkflowDomainFixture({
        run: () => Deferred.await(finish).pipe(Effect.as("done")),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        const observer = yield* (yield* workflows.observe(receipt)).pipe(
          Stream.runForEach((event) => Queue.offer(changes, event._tag)),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(changes)).toBe("Snapshot");
        yield* workflows.pause(receipt);
        expect(yield* Queue.take(changes)).toBe("RunChanged");
        yield* Fiber.interrupt(observer);
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("retains worker inspection through Pi after ephemeral runtime release", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        yield* workflows.start(launchInput);
        const request = yield* Queue.take(f.assignments);
        yield* drain;
        const activity = yield* workflows.inspectWorker(request.target);
        expect(activity.parts[0]).toMatchObject({ text: "Retained answer" });
        const persisted = [...(yield* Ref.get(f.records)).values()][0];
        expect(JSON.stringify(persisted)).not.toContain("Retained answer");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("holds new workers on Pause while active workers finish and checkpoint", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const secondQueued = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) =>
          Effect.gen(function* () {
            yield* host.agent({ prompt: "first", options: {} }, "throw");
            yield* Deferred.succeed(secondQueued, undefined);
            return yield* host.agent({ prompt: "second", options: {} }, "throw");
          }),
        worker: (request) =>
          request.input.prompt === "first"
            ? Deferred.await(finish).pipe(Effect.as({ result: "done" }))
            : Effect.succeed({ result: "second" }),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        yield* workflows.pause(receipt);
        yield* Deferred.succeed(finish, undefined);
        yield* Deferred.await(secondQueued);
        const paused = yield* workflows.inspect(receipt);
        expect(paused.status).toBe("paused");
        expect(paused.steps[0]?.status).toBe("complete");
        expect(yield* Queue.size(f.assignments)).toBe(0);
        yield* workflows.resume(receipt);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).steps.map((step) => step.status)).toEqual([
          "complete",
          "complete",
        ]);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("finishes a paused run when its last active worker completes and no work remains", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        yield* workflows.pause(receipt);
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).status).toBe("complete");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("resumes queued work without duplicating already-active workers", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        yield* workflows.pause(receipt);
        yield* workflows.resume(receipt);
        expect(yield* Queue.size(f.assignments)).toBe(0);
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).steps).toHaveLength(1);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("cancels queued work and waits for active cancellation before publishing stopped", () =>
    Effect.gen(function* () {
      const cancelStarted = yield* Deferred.make<void>();
      const finishCleanup = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () =>
          Effect.never.pipe(
            Effect.ensuring(
              Deferred.succeed(cancelStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishCleanup)),
              ),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        const stop = yield* workflows.stop(receipt).pipe(Effect.forkScoped);
        yield* Deferred.await(cancelStarted);
        expect((yield* workflows.inspect(receipt)).status).toBe("stopping");
        yield* Deferred.succeed(finishCleanup, undefined);
        yield* Fiber.join(stop);
        expect((yield* workflows.inspect(receipt)).status).toBe("stopped");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("does not undo filesystem edits when stopping or restarting a worker", () =>
    Effect.gen(function* () {
      const edits: string[] = [];
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "edit", options: {} }, "throw"),
        worker: (request) =>
          Effect.sync(() => {
            edits.push(`attempt-${request.attempt}`);
          }).pipe(
            Effect.andThen(
              request.attempt === 1 ? Effect.never : Effect.succeed({ result: "done" }),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        const request = yield* Queue.take(f.assignments);
        yield* workflows.restartWorker(request.target);
        const restarted = yield* Queue.take(f.assignments);
        expect(restarted.attempt).toBe(2);
        yield* drain;
        expect(edits).toEqual(["attempt-1", "attempt-2"]);
        expect((yield* workflows.inspect(receipt)).steps[0]?.attempt).toBe(2);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("rejects relaunch while previous workers are still stopping", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const cleanup = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () =>
          Effect.never.pipe(
            Effect.ensuring(
              Deferred.succeed(cancelled, undefined).pipe(Effect.andThen(Deferred.await(cleanup))),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        const stopping = yield* workflows.stop(receipt).pipe(Effect.forkScoped);
        yield* Deferred.await(cancelled);
        expect((yield* Effect.result(workflows.relaunch(receipt)))._tag).toBe("Failure");
        yield* Deferred.succeed(cleanup, undefined);
        yield* Fiber.join(stopping);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect(
    "replays the matching successful prefix and reruns from the first failed or changed call",
    () =>
      Effect.gen(function* () {
        let revised = false;
        const f = yield* makeWorkflowDomainFixture({
          run: (host) =>
            Effect.forEach(["A", "B", "C"], (name) =>
              host.agent(
                { prompt: revised && name === "B" ? "B-revised" : name, options: {} },
                "throw",
              ),
            ),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const receipt = yield* workflows.start(launchInput);
          yield* drain;
          expect(yield* Queue.size(f.assignments)).toBe(3);
          yield* Queue.takeAll(f.assignments);
          revised = true;
          yield* workflows.relaunch(receipt);
          yield* drain;
          const repeated = yield* Queue.takeAll(f.assignments);
          expect(repeated.map((request) => request.input.prompt)).toEqual(["B-revised", "C"]);
        }).pipe(Effect.provide(f.layer));
      }),
  );
  // A,B,C,D start in order; B fails and C,D finish. Replay reuses only A.
  it.effect("invalidates completed later siblings after an earlier fan-out failure", () =>
    Effect.gen(function* () {
      let fail = true;
      const f = yield* makeWorkflowDomainFixture({
        run: (host) =>
          Effect.forEach(
            ["A", "B", "C", "D"],
            (prompt) => host.agent({ prompt, options: {} }, "null"),
            { concurrency: "unbounded" },
          ),
        worker: (request) =>
          fail && request.input.prompt === "B"
            ? Effect.fail(
                new WorkflowError({ operation: "run", reason: "worker", message: "B failed" }),
              )
            : Effect.succeed({ result: request.input.prompt }),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).result).toEqual(["A", null, "C", "D"]);
        yield* Queue.takeAll(f.assignments);
        fail = false;
        yield* workflows.relaunch(receipt);
        yield* drain;
        expect(
          (yield* Queue.takeAll(f.assignments)).map((request) => request.input.prompt),
        ).toEqual(["B", "C", "D"]);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect(
    "returns an explicit error rather than silently starting fresh when a checkpoint is missing",
    () =>
      Effect.gen(function* () {
        const f = yield* makeWorkflowDomainFixture({ run: () => Effect.succeed("done") });
        yield* Effect.gen(function* () {
          expect((yield* Effect.result(workflows.relaunch(target)))._tag).toBe("Failure");
          expect((yield* Ref.get(f.records)).size).toBe(0);
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect(
    "marks interrupted execution honestly after backend restart and requires deliberate relaunch",
    () =>
      Effect.gen(function* () {
        const f = yield* makeWorkflowDomainFixture({
          run: () => Effect.die("Unexpected automatic execution"),
        });
        yield* Effect.gen(function* () {
          yield* (yield* WorkflowRunStorage).save(checkpoint(), null);
          expect((yield* workflows.inspect(target)).status).toBe("interrupted");
          expect(yield* Queue.size(f.assignments)).toBe(0);
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect(
    "bounds active workers and rejects a thousand-and-first step without dropping work",
    () =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const f = yield* makeWorkflowDomainFixture({
          run: (host) =>
            Effect.forEach(
              Array.from({ length: 20 }, (_, index) => index),
              (index) => host.agent({ prompt: `item-${index}`, options: {} }, "throw"),
              { concurrency: "unbounded" },
            ),
          worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const receipt = yield* workflows.start(launchInput);
          yield* Queue.take(f.assignments);
          yield* Queue.take(f.assignments);
          yield* (yield* workflows.observeRun(receipt)).pipe(
            Stream.filter(
              (event) => event._tag !== "WorkerActivity" && event.run.steps.length === 20,
            ),
            Stream.runHead,
          );
          expect(yield* Queue.size(f.assignments)).toBe(0);
          expect(
            (yield* workflows.inspect(receipt)).steps.filter((step) => step.status === "running"),
          ).toHaveLength(2);
          yield* Deferred.succeed(finish, undefined);
          yield* drain;
          expect((yield* workflows.inspect(receipt)).steps).toHaveLength(20);
        }).pipe(
          Effect.provide(f.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ CAKE_WORKFLOW_MAX_CONCURRENT_AGENTS: 2 }),
            ),
          ),
        );
        const large = yield* makeWorkflowDomainFixture({
          run: (host) =>
            Effect.forEach(
              Array.from({ length: 1001 }, (_, index) => index),
              (index) => host.agent({ prompt: `item-${index}`, options: {} }, "throw"),
            ),
        });
        yield* Effect.gen(function* () {
          yield* large.registerOwner;
          const receipt = yield* workflows.start(launchInput);
          yield* drain;
          const result = yield* workflows.inspect(receipt);
          expect(result.status).toBe("error");
          expect(result.steps).toHaveLength(1000);
          expect(result.error).toContain("1000");
        }).pipe(Effect.provide(large.layer));
      }),
  );
  it.effect(
    "preserves null entries in batch results but fails a directly awaited exhausted worker",
    () =>
      Effect.gen(function* () {
        for (const mode of ["null", "throw"] as const) {
          const f = yield* makeWorkflowDomainFixture({
            run: (host) => host.agent({ prompt: "fail", options: {} }, mode),
            worker: () =>
              Effect.fail(
                new WorkflowError({ operation: "run", reason: "worker", message: "Failed worker" }),
              ),
          });
          yield* Effect.gen(function* () {
            yield* f.registerOwner;
            const receipt = yield* workflows.start(launchInput);
            yield* drain;
            const run = yield* workflows.inspect(receipt);
            expect(run.status).toBe(mode === "null" ? "complete" : "error");
            if (mode === "null") expect(run.result).toBeNull();
            else expect(run.error).toContain("Failed worker");
          }).pipe(Effect.provide(f.layer));
        }
      }),
  );
  it.effect("records worker usage across automatic and manually requested attempts", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "work", options: {} }, "throw"),
        worker: (request) =>
          request
            .onActivity({
              stepId: request.target.stepId,
              execution: request.target.execution,
              attempt: request.attempt,
              streaming: true,
              parts: [],
              usage: {
                tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                cost: 0.01,
              },
            })
            .pipe(
              Effect.andThen(
                request.attempt === 1
                  ? Effect.fail(
                      new WorkflowError({
                        operation: "run",
                        reason: "stalled",
                        message: "stalled",
                      }),
                    )
                  : request.attempt === 2
                    ? Effect.never
                    : Effect.succeed({
                        result: "done",
                        usage: {
                          tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                          cost: 0.01,
                        },
                      }),
              ),
            ),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        const second = yield* Queue.take(f.assignments);
        yield* workflows.restartWorker(second.target);
        yield* drain;
        const run = yield* workflows.inspect(receipt);
        expect(run.usage?.tokens.total).toBe(3);
        expect(run.usage?.cost).toBeCloseTo(0.03);
        expect(run.steps[0]?.attempt).toBe(3);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("restarts stalled workers from their assignment at most five times", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "stall", options: {} }, "throw"),
        worker: () =>
          Effect.fail(
            new WorkflowError({ operation: "run", reason: "stalled", message: "stalled" }),
          ),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* drain;
        const attempts = yield* Queue.takeAll(f.assignments);
        expect(attempts.map((request) => request.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
        expect((yield* workflows.inspect(receipt)).status).toBe("error");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("does not count time awaiting worker tools against the stall window", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "long tool", options: { stallMs: 1000 } }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* Queue.take(f.assignments);
        yield* TestClock.adjust("1 day");
        expect(yield* Queue.size(f.assignments)).toBe(0);
        expect((yield* workflows.inspect(receipt)).steps[0]?.attempt).toBe(1);
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("rejects foreign run and step targets rather than routing them to another owner", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({ run: () => Effect.succeed("done") });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        yield* drain;
        expect(
          (yield* Effect.result(workflows.inspect({ ...receipt, sessionId: "foreign" })))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("rejects late worker controls and activity from a previous relaunch execution", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(launchInput);
        const old = yield* Queue.take(f.assignments);
        yield* drain;
        yield* workflows.relaunch(receipt);
        yield* drain;
        expect((yield* Effect.result(workflows.stopWorker(old.target)))._tag).toBe("Failure");
        expect(
          (yield* Effect.result(
            old.onActivity({
              stepId: old.target.stepId,
              execution: 1,
              attempt: 1,
              streaming: false,
              parts: [],
              usage: {
                tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, total: 50 },
                cost: 1,
              },
            }),
          ))._tag,
        ).toBe("Failure");
        expect((yield* workflows.inspect(receipt)).usage?.tokens.total ?? 0).toBe(0);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect(
    "prevents session resolution and checkout retirement while owned workflows are active",
    () =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
          worker: () => Deferred.await(finish).pipe(Effect.as({ result: "done" })),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const receipt = yield* workflows.start(launchInput);
          yield* Queue.take(f.assignments);
          expect(yield* hasActive({ sessionId: receipt.sessionId })).toBe(true);
          expect(yield* hasActive({ workingDirectory: "/project" })).toBe(true);
          expect(yield* hasActive({ workingDirectory: "/other" })).toBe(false);
          yield* workflows.pause(receipt);
          expect(yield* hasActive({ sessionId: receipt.sessionId })).toBe(true);
          yield* Deferred.succeed(finish, undefined);
          yield* drain;
          expect(yield* hasActive({ workingDirectory: "/project" })).toBe(false);
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect(
    "fails visibly on checkpoint persistence errors without releasing an uncheckpointed answer",
    () =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
          worker: () =>
            Deferred.succeed(reached, undefined).pipe(Effect.as({ result: "uncheckpointed" })),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const original = yield* WorkflowRunStorage;
          const save = (value: WorkflowCheckpoint, revision: number | null) =>
            value.run.steps.some((step) => step.status === "complete")
              ? Effect.fail(
                  new WorkflowError({ operation: "save", reason: "storage", message: "disk full" }),
                )
              : original.save(value, revision);
          const receipt = yield* workflows
            .start(launchInput)
            .pipe(Effect.provideService(WorkflowRunStorage, { ...original, save }));
          yield* Deferred.await(reached);
          yield* drain;
          const run = yield* workflows.inspect(receipt);
          expect(run.status).toBe("error");
          expect(run.result).toBeUndefined();
          expect(run.error).toContain("disk full");
        }).pipe(Effect.provide(f.layer));
      }),
  );
});
