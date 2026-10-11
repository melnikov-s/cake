import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect, FiberMap, Queue, Ref, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import * as workflows from "../../../src/domain/workflows/workflows";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { holdsCompletion } from "../../../src/domain/workflows/workflow-lifecycle";
import { WorkflowSupervisor } from "../../../src/services/workflows/WorkflowSupervisor";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import {
  ProjectSessionRuntimeHost,
  ProjectSessionRuntimeHostError,
} from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { makeWorkflowDomainFixture } from "../helpers/workflowDomainFixture";

const input = { sessionId: "session-1", scriptPath: "/project/workflow.js" };
const drain = Effect.gen(function* () {
  const supervisor = yield* WorkflowSupervisor;
  yield* FiberMap.awaitEmpty(supervisor.runs);
  yield* FiberMap.awaitEmpty(supervisor.reports);
});
const assignment = (turnId: string) => ({
  turnId,
  sessionId: input.sessionId,
  senderSessionId: "parent",
  requestMessageId: turnId,
  threadId: turnId,
  expectsResponse: true,
  reported: false,
  completionContract: true,
});

describe("Workflow completion ownership", () => {
  it.effect(
    "external launches do not claim an assignment executing in the targeted Project Session",
    () =>
      Effect.gen(function* () {
        const f = yield* makeWorkflowDomainFixture({
          run: () => Effect.succeed("external findings"),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const journal = yield* SessionFamilyStorage;
          yield* journal.recordTurn(assignment("unrelated-active"));
          f.executing.push("unrelated-active");
          const receipt = yield* workflows.start(input);
          yield* drain;
          expect((yield* Ref.get(f.records)).get(receipt.runId)?.completionTurnIds).toEqual([]);
          expect(
            (yield* journal.state()).turns.find((turn) => turn.turnId === "unrelated-active")
              ?.outcome,
          ).toBeUndefined();
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "waits for the launch turn to finish before settling a fast run and includes later runs from that turn",
    () =>
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const second = yield* Deferred.make<void>();
        let ordinal = 0;
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: `audit-${++ordinal}`, options: {} }, "throw"),
          worker: (request) =>
            Deferred.await(request.input.prompt === "audit-1" ? first : second).pipe(
              Effect.as({ result: request.input.prompt }),
            ),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const journal = yield* SessionFamilyStorage;
          yield* journal.recordTurn(assignment("launch"));
          f.executing.push("launch");
          const firstRun = yield* workflows.start(input, input.sessionId);
          yield* Queue.take(f.assignments);
          yield* Deferred.succeed(first, undefined);
          yield* Queue.take(f.reports);
          // Wait for durable delivery, not for the still-executing launch assignment.
          const supervisor = yield* WorkflowSupervisor;
          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.filter(
              (state) => state.get(firstRun.runId)?.checkpoint.completionDelivery === "delivered",
            ),
            Stream.runHead,
          );
          expect(
            (yield* journal.state()).turns.find((turn) => turn.turnId === "launch")?.outcome,
          ).toBeUndefined();
          yield* workflows.start(input, input.sessionId);
          yield* Queue.take(f.assignments);
          f.executing.length = 0;
          yield* Deferred.succeed(second, undefined);
          yield* TestClock.adjust("1 second");
          yield* drain;
          const report = (yield* journal.state()).turns.find(
            (turn) => turn.turnId === "launch",
          )?.report;
          expect(report?.text).toContain("audit-1");
          expect(report?.text).toContain("audit-2");
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect(
    "reassembles the Project owner and reports after all observer and launch leases close",
    () =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
          worker: () => Deferred.await(finish).pipe(Effect.as({ result: "actual findings" })),
        });
        yield* Effect.gen(function* () {
          const receipt = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* f.registerOwner;
              const receipt = yield* workflows.start(input);
              yield* Queue.take(f.assignments);
              return receipt;
            }),
          );
          expect(yield* Queue.take(f.disposed)).toBe(input.sessionId);
          yield* Deferred.succeed(finish, undefined);
          yield* drain;
          expect((yield* workflows.inspect(receipt)).status).toBe("complete");
          expect(yield* Queue.take(f.reports)).toContain("actual findings");
          expect(yield* Queue.size(f.reports)).toBe(0);
          expect((yield* Ref.get(f.records)).get(receipt.runId)?.completionDelivery).toBe(
            "delivered",
          );
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect("retries a failed cold-owner report without rerunning workers", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<void>();
      const f = yield* makeWorkflowDomainFixture({
        run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
        worker: () => Deferred.await(finish).pipe(Effect.as({ result: "findings" })),
      });
      yield* Effect.gen(function* () {
        const original = yield* ProjectSessionRuntimeHost;
        let fail = true;
        const host = ProjectSessionRuntimeHost.of({
          ...original,
          runtimeIntegrations: (cwd, id) =>
            Effect.suspend(() => {
              if (!fail) return original.runtimeIntegrations(cwd, id);
              fail = false;
              return Deferred.succeed(failed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProjectSessionRuntimeHostError({
                      operation: "runtimeIntegrations",
                      message: "temporary owner acquisition failure",
                    }),
                  ),
                ),
              );
            }),
        });
        const receipt = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.registerOwner;
            const receipt = yield* workflows
              .start(input)
              .pipe(Effect.provideService(ProjectSessionRuntimeHost, host));
            yield* Queue.take(f.assignments);
            return receipt;
          }),
        );
        yield* Deferred.succeed(finish, undefined);
        yield* Deferred.await(failed);
        expect((yield* workflows.inspect(receipt)).status).toBe("complete");
        expect((yield* Ref.get(f.records)).get(receipt.runId)?.completionDelivery).toBe("pending");
        yield* TestClock.adjust("1 second");
        yield* drain;
        expect(yield* Queue.take(f.reports)).toContain("findings");
        expect(yield* Queue.size(f.reports)).toBe(0);
        expect(yield* Queue.size(f.assignments)).toBe(0);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect(
    "combines only the initiating assignment's runs and never settles a queued assignment",
    () =>
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const second = yield* Deferred.make<void>();
        let ordinal = 0;
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: `audit-${++ordinal}`, options: {} }, "throw"),
          worker: (request) =>
            Deferred.await(request.input.prompt === "audit-1" ? first : second).pipe(
              Effect.as({ result: request.input.prompt + " findings" }),
            ),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const journal = yield* SessionFamilyStorage;
          yield* journal.recordTurn(assignment("launch"));
          yield* journal.recordTurn(assignment("queued"));
          f.executing.push("launch");
          yield* workflows.start(input, input.sessionId);
          yield* Queue.take(f.assignments);
          yield* workflows.start(input, input.sessionId);
          yield* Queue.take(f.assignments);
          f.executing.length = 0;
          yield* Deferred.succeed(first, undefined);
          yield* Queue.take(f.reports);
          yield* FiberMap.awaitEmpty((yield* WorkflowSupervisor).reports);
          expect(
            (yield* journal.state()).turns.find((turn) => turn.turnId === "launch")?.outcome,
          ).toBeUndefined();
          expect(
            (yield* journal.state()).turns.find((turn) => turn.turnId === "queued")?.outcome,
          ).toBeUndefined();
          yield* Deferred.succeed(second, undefined);
          yield* drain;
          const turns = (yield* journal.state()).turns;
          expect(turns.find((turn) => turn.turnId === "launch")?.report?.text).toContain(
            "audit-1 findings",
          );
          expect(turns.find((turn) => turn.turnId === "launch")?.report?.text).toContain(
            "audit-2 findings",
          );
          expect(turns.find((turn) => turn.turnId === "queued")?.outcome).toBeUndefined();
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "does not hold an unrelated turn's ordinary settlement while a workflow is active",
    () =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const f = yield* makeWorkflowDomainFixture({
          run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
          worker: () => Deferred.await(finish).pipe(Effect.as({ result: "findings" })),
        });
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const journal = yield* SessionFamilyStorage;
          yield* journal.recordTurn(assignment("launch"));
          yield* journal.recordTurn(assignment("other"));
          f.executing.push("launch");
          yield* workflows.start(input, input.sessionId);
          yield* Queue.take(f.assignments);
          const options = yield* acquireOptions({
            sessionId: input.sessionId,
            newSession: false,
            location: {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/project",
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved",
            },
          });
          if (!options.onTurnSettled) throw new Error("Missing Project settlement hook");
          yield* options.onTurnSettled({
            sessionId: input.sessionId,
            turnId: "launch",
            outcome: "complete",
          });
          yield* options.onTurnSettled({
            sessionId: input.sessionId,
            turnId: "other",
            outcome: "complete",
          });
          const turns = (yield* journal.state()).turns;
          expect(turns.find((turn) => turn.turnId === "launch")?.outcome).toBeUndefined();
          expect(turns.find((turn) => turn.turnId === "other")?.outcome).toBe("complete");
          expect(yield* holdsCompletion(input.sessionId, "launch")).toBe(true);
          expect(yield* holdsCompletion(input.sessionId, "other")).toBe(false);
          f.executing.length = 0;
          yield* Deferred.succeed(finish, undefined);
          yield* drain;
          expect(
            (yield* journal.state()).turns.find((turn) => turn.turnId === "launch")?.report?.text,
          ).toBe("findings");
        }).pipe(Effect.provide(f.layer));
      }),
  );
});
