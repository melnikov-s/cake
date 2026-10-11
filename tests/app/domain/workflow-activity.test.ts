import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect, Fiber, FiberMap, PubSub, Queue, Ref, Stream } from "effect";
import * as workflows from "../../../src/domain/workflows/workflows";
import { WorkflowSupervisor } from "../../../src/services/workflows/WorkflowSupervisor";
import { makeWorkflowDomainFixture } from "../helpers/workflowDomainFixture";
import type {
  WorkflowRunUpdate,
  WorkflowWorkerActivity,
} from "../../../src/contracts/workflows/workflow-data";
import type { WorkflowWorkerRequest } from "../../../src/services/pi/WorkflowWorkers";

const input = { sessionId: "session-1", scriptPath: "/project/workflow.js" };
const activity = (request: WorkflowWorkerRequest, text: string): WorkflowWorkerActivity => ({
  stepId: request.target.stepId,
  execution: request.target.execution,
  attempt: request.attempt,
  streaming: true,
  parts: [{ kind: "text", id: "answer", role: "assistant", text, status: "streaming" }],
});
const nextActivity = (updates: Queue.Queue<WorkflowRunUpdate>) =>
  Effect.gen(function* () {
    let update = yield* Queue.take(updates);
    while (update._tag !== "WorkerActivity") update = yield* Queue.take(updates);
    return update;
  });
const drain = Effect.gen(function* () {
  const supervisor = yield* WorkflowSupervisor;
  yield* FiberMap.awaitEmpty(supervisor.runs);
  yield* FiberMap.awaitEmpty(supervisor.reports);
});

describe("Workflow live-activity projection", () => {
  it.effect(
    "streams token activity without checkpointing transcript parts or unchanged usage",
    () =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
          worker: () => Deferred.await(finish).pipe(Effect.as({ result: "findings" })),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const receipt = yield* workflows.start(input);
          const request = yield* Queue.take(f.assignments);
          const updates = yield* Queue.unbounded<WorkflowRunUpdate>();
          const observer = yield* (yield* workflows.observeRun(receipt)).pipe(
            Stream.runForEach((update) => Queue.offer(updates, update)),
            Effect.forkScoped,
          );
          expect((yield* Queue.take(updates))._tag).toBe("Snapshot");
          const before = (yield* workflows.inspect(receipt)).revision;
          for (let i = 0; i < 20; i++) {
            yield* request.onActivity(activity(request, `token ${i}`));
            expect((yield* nextActivity(updates)).activity.parts[0]).toMatchObject({
              text: `token ${i}`,
            });
          }
          expect((yield* workflows.inspect(receipt)).revision).toBe(before);
          const usage = {
            tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10 },
            cost: 0.01,
          };
          yield* request.onActivity({ ...activity(request, "with usage"), usage });
          yield* request.onActivity({ ...activity(request, "same usage"), usage });
          expect((yield* workflows.inspect(receipt)).revision).toBe(before + 1);
          expect((yield* workflows.inspect(receipt)).usage).toEqual(usage);
          expect(JSON.stringify((yield* Ref.get(f.records)).get(receipt.runId))).not.toContain(
            "token 19",
          );
          yield* Fiber.interrupt(observer);
          yield* Deferred.succeed(finish, undefined);
          yield* drain;
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect("orders snapshot, status and activity and rejects old attempts and executions", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Effect.never,
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(input);
        const first = yield* Queue.take(f.assignments);
        const updates = yield* Queue.unbounded<WorkflowRunUpdate>();
        const observer = yield* (yield* workflows.observeRun(receipt)).pipe(
          Stream.runForEach((update) => Queue.offer(updates, update)),
          Effect.forkScoped,
        );
        const snapshot = yield* Queue.take(updates);
        expect(snapshot._tag).toBe("Snapshot");
        yield* first.onActivity(activity(first, "first"));
        const initial = yield* nextActivity(updates);
        expect(initial.revision).toBeGreaterThan(snapshot.revision);
        yield* workflows.restartWorker(first.target);
        const second = yield* Queue.take(f.assignments);
        yield* first.onActivity(activity(first, "stale attempt"));
        const supervisor = yield* WorkflowSupervisor;
        yield* PubSub.publish(supervisor.activity, {
          runId: receipt.runId,
          activity: {
            ...activity(second, "stale execution"),
            execution: second.target.execution + 1,
          },
        });
        yield* second.onActivity(activity(second, "second"));
        const next = yield* nextActivity(updates);
        expect(next.activity.attempt).toBe(2);
        expect(next.activity.parts[0]).toMatchObject({ text: "second" });
        expect(next.revision).toBeGreaterThan(initial.revision);
        yield* Fiber.interrupt(observer);
        yield* workflows.stop(receipt);
        yield* drain;
        const replay = yield* workflows.relaunch(receipt);
        const third = yield* Queue.take(f.assignments);
        expect(third.target.execution).toBe(2);
        expect(
          (yield* Effect.result(first.onActivity(activity(first, "old execution"))))._tag,
        ).toBe("Failure");
        yield* workflows.stop(replay);
        yield* drain;
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("dropping details releases the subscription without stopping its workflow", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "findings" })),
      });
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const receipt = yield* workflows.start(input);
        const request = yield* Queue.take(f.assignments);
        yield* Stream.runHead(yield* workflows.observeRun(receipt));
        const supervisor = yield* WorkflowSupervisor;
        yield* request.onActivity(activity(request, "not observed"));
        expect(yield* PubSub.size(supervisor.activity)).toBe(0);
        expect((yield* workflows.inspect(receipt)).status).toBe("running");
        yield* Deferred.succeed(finish, undefined);
        yield* drain;
        expect((yield* workflows.inspect(receipt)).status).toBe("complete");
      }).pipe(Effect.provide(f.layer));
    }),
  );
});
