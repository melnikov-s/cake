import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Context, Effect, Fiber, FiberMap, Layer, Queue, Ref } from "effect";
import * as workflows from "../../../src/domain/workflows/workflows";
import * as control from "../../../src/domain/workflows/workflow-control";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientConnectionsLive } from "../../../src/services/clients/ClientConnections";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { WorkflowSupervisor } from "../../../src/services/workflows/WorkflowSupervisor";
import { makeWorkflowDomainFixture } from "../helpers/workflowDomainFixture";
import { checkpoint } from "../helpers/workflowFixture";

const input = {
  sessionId: "session-1",
  scriptPath: "/project/workflow.js",
  args: { task: "audit" },
};
const projectCaller = { _tag: "ProjectSession" as const, sessionId: input.sessionId };
const makeFixture = Effect.fn("WorkflowProposal.fixture")(function* (
  profile?: "ProjectSession" | "CakeChatSession" | "DiscussionSession",
  dynamicWorkflows = true,
) {
  const requests = yield* Queue.unbounded<Extract<CakeEvent, { type: "ui-request" }>>();
  const settled = yield* Queue.unbounded<Extract<CakeEvent, { type: "ui-request-settled" }>>();
  const context = yield* Layer.build(
    RendererRequestCoordinatorLive.pipe(
      Layer.provide(
        Layer.merge(
          ClientConnectionsLive,
          Layer.mock(ClientEvents, {
            broadcast: () => {
              throw new Error("Unexpected broadcast");
            },
            sendTo: (_connection, event) => {
              if (event.type === "ui-request") Queue.offerUnsafe(requests, event);
              if (event.type === "ui-request-settled") Queue.offerUnsafe(settled, event);
              return true;
            },
          }),
        ),
      ),
    ),
  );
  const coordinator = Context.get(context, RendererRequestCoordinator);
  const domain = yield* makeWorkflowDomainFixture({
    profile,
    dynamicWorkflows,
    run: (host) => host.agent({ prompt: "audit", options: {} }, "throw"),
  });
  return { ...domain, coordinator, requests, settled };
});
const response = (
  request: Extract<CakeEvent, { type: "ui-request" }>,
  value?: string,
  cancelled = false,
) => ({
  requestId: request.requestId,
  sessionId: request.sessionId,
  uiRequestId: request.uiRequestId,
  value,
  cancelled,
});
const drain = Effect.gen(function* () {
  const supervisor = yield* WorkflowSupervisor;
  yield* FiberMap.awaitEmpty(supervisor.runs);
  yield* FiberMap.awaitEmpty(supervisor.reports);
});

describe("Workflow execution choice", () => {
  it.effect("treats existing application state without experimental settings as disabled", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.application.transact((state) =>
        Effect.sync(() => {
          const next = { ...state };
          delete next.experimentalFeatures;
          return next;
        }),
      );
      const result = yield* workflows.start(input).pipe(Effect.result, Effect.provide(f.layer));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("Dynamic workflows are disabled") },
      });
      expect(yield* Queue.size(f.programs)).toBe(0);
      expect((yield* Ref.get(f.records)).size).toBe(0);
    }),
  );
  it.effect(
    "disabled experiments reject every launch path before reading source or presenting a choice",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture(undefined, false);
        f.scripts.clear();
        yield* Effect.gen(function* () {
          for (const caller of [
            projectCaller,
            { _tag: "CakeChatSession" as const, sessionId: "cake-chat" },
          ]) {
            for (const [command, value] of [
              ["workflows.propose", input],
              ["workflows.start", input],
              ["workflows.relaunch", { sessionId: input.sessionId, runId: checkpoint().run.id }],
            ] as const) {
              const result = yield* Effect.result(
                control.invoke(command, value, caller, new AbortController().signal),
              );
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { message: expect.stringContaining("Dynamic workflows are disabled") },
              });
            }
          }
          expect(yield* Queue.size(f.requests)).toBe(0);
          expect(yield* Queue.size(f.programs)).toBe(0);
          expect(yield* Queue.size(f.assignments)).toBe(0);
          expect((yield* Ref.get(f.records)).size).toBe(0);
        }).pipe(
          Effect.provideService(RendererRequestCoordinator, f.coordinator),
          Effect.provide(f.layer),
        );
      }),
  );
  it.effect(
    "turning the experiment off cancels a pending choice; re-enabling needs a fresh choice",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          yield* f.coordinator.bind(projectCaller, 11);
          const pending = yield* workflows
            .propose(input, projectCaller, new AbortController().signal)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const request = yield* Queue.take(f.requests);
          yield* f.application.transact((state) =>
            Effect.succeed({ ...state, experimentalFeatures: { dynamicWorkflows: false } }),
          );
          expect(yield* Fiber.join(pending)).toEqual({ choice: "cancelled" });
          expect((yield* Queue.take(f.settled)).uiRequestId).toBe(request.uiRequestId);
          yield* f.application.transact((state) =>
            Effect.succeed({ ...state, experimentalFeatures: { dynamicWorkflows: true } }),
          );
          yield* f.coordinator.respondUi(
            11,
            projectCaller.sessionId,
            response(request, "workflow"),
          );
          expect((yield* Ref.get(f.records)).size).toBe(0);
          expect(yield* Queue.size(f.programs)).toBe(0);
          const fresh = yield* workflows
            .propose(input, projectCaller, new AbortController().signal)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const next = yield* Queue.take(f.requests);
          expect(next.uiRequestId).not.toBe(request.uiRequestId);
          yield* f.coordinator.respondUi(11, projectCaller.sessionId, response(next, "normal"));
          expect(yield* Fiber.join(fresh)).toEqual({ choice: "normal" });
        }).pipe(
          Effect.provideService(RendererRequestCoordinator, f.coordinator),
          Effect.provide(f.layer),
        );
      }),
  );
  it.effect("rejects non-Project execution owners before presenting a suggestion", () =>
    Effect.gen(function* () {
      for (const profile of ["CakeChatSession", "DiscussionSession"] as const) {
        const f = yield* makeFixture(profile);
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          expect(
            (yield* Effect.result(
              workflows.propose(input, projectCaller, new AbortController().signal),
            ))._tag,
          ).toBe("Failure");
          expect(yield* Queue.size(f.requests)).toBe(0);
          expect((yield* Ref.get(f.records)).size).toBe(0);
        }).pipe(
          Effect.provideService(RendererRequestCoordinator, f.coordinator),
          Effect.provide(f.layer),
        );
      }
    }),
  );
  for (const caller of [
    projectCaller,
    { _tag: "CakeChatSession" as const, sessionId: "cake-chat" },
  ]) {
    it.effect(
      `freezes a suggested program and launches exactly once after ${caller._tag} choice`,
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture();
          yield* Effect.gen(function* () {
            yield* f.registerOwner;
            yield* f.coordinator.bind(caller, 11);
            const abort = new AbortController();
            const pending = yield* control
              .invoke("workflows.propose", input, caller, abort.signal)
              .pipe(Effect.forkChild({ startImmediately: true }));
            const request = yield* Queue.take(f.requests);
            expect(request.kind).toBe("workflow-choice");
            expect(request.sessionId).toBe(caller.sessionId);
            expect(request.workflow?.ownerSessionId).toBe(input.sessionId);
            expect(request.workflow?.program).toEqual({
              ...checkpoint().run.program,
              args: input.args,
            });
            expect((yield* Ref.get(f.records)).size).toBe(0);
            expect(yield* Queue.size(f.programs)).toBe(0);
            expect(yield* Queue.size(f.assignments)).toBe(0);
            f.scripts.set(input.scriptPath, {
              ...checkpoint().run.program,
              source: "changed after presentation",
            });
            // Malformed and wrongly routed replies cannot accept the execution choice.
            expect(
              (yield* Effect.result(
                f.coordinator.respondUi(11, caller.sessionId, response(request, "true")),
              ))._tag,
            ).toBe("Failure");
            expect(
              (yield* Effect.result(
                f.coordinator.respondUi(22, caller.sessionId, response(request, "workflow")),
              ))._tag,
            ).toBe("Failure");
            yield* f.coordinator.respondUi(11, caller.sessionId, response(request, "workflow"));
            yield* f.coordinator.respondUi(11, caller.sessionId, response(request, "workflow"));
            const result = yield* Fiber.join(pending);
            expect(result).toMatchObject({
              choice: "workflow",
              run: { sessionId: input.sessionId },
            });
            yield* drain;
            expect((yield* Ref.get(f.records)).size).toBe(1);
            expect((yield* Queue.take(f.programs)).source).toBe(request.workflow?.program.source);
            expect(yield* Queue.size(f.programs)).toBe(0);
            expect((yield* Queue.take(f.assignments)).target.sessionId).toBe(input.sessionId);
            expect(yield* Queue.size(f.assignments)).toBe(0);
            expect((yield* Queue.take(f.settled)).uiRequestId).toBe(request.uiRequestId);
          }).pipe(
            Effect.provideService(RendererRequestCoordinator, f.coordinator),
            Effect.provide(f.layer),
          );
        }),
    );
  }
  for (const outcome of [
    "normal",
    "cancel",
    "abort",
    "disconnect",
    "release",
    "interrupt",
  ] as const) {
    it.effect(
      `${outcome} settles without sandbox or worker execution; stale acceptance cannot launch`,
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture();
          yield* Effect.gen(function* () {
            yield* f.registerOwner;
            const caller =
              outcome === "release"
                ? { _tag: "CakeChatSession" as const, sessionId: "cake-chat" }
                : projectCaller;
            yield* f.coordinator.bind(caller, 11);
            const abort = new AbortController();
            const pending = yield* workflows
              .propose(input, caller, abort.signal)
              .pipe(Effect.forkChild({ startImmediately: true }));
            const request = yield* Queue.take(f.requests);
            switch (outcome) {
              case "normal":
                yield* f.coordinator.respondUi(11, caller.sessionId, response(request, "normal"));
                break;
              case "cancel":
                yield* f.coordinator.respondUi(
                  11,
                  caller.sessionId,
                  response(request, undefined, true),
                );
                break;
              case "abort":
                abort.abort();
                break;
              case "disconnect":
                yield* f.coordinator.releaseConnection(11);
                break;
              case "release":
                yield* f.coordinator.releaseSession(caller);
                break;
              case "interrupt":
                yield* Fiber.interrupt(pending);
                break;
            }
            if (outcome !== "interrupt")
              expect(yield* Fiber.join(pending)).toEqual({
                choice: outcome === "normal" ? "normal" : "cancelled",
              });
            yield* Queue.take(f.settled);
            yield* f.coordinator.respondUi(11, caller.sessionId, response(request, "workflow"));
            expect((yield* Ref.get(f.records)).size).toBe(0);
            expect(yield* Queue.size(f.programs)).toBe(0);
            expect(yield* Queue.size(f.assignments)).toBe(0);
          }).pipe(
            Effect.provideService(RendererRequestCoordinator, f.coordinator),
            Effect.provide(f.layer),
          );
        }),
    );
  }
  it.effect("explicit execution skips the choice; an already-aborted proposal starts nothing", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const abort = new AbortController();
        abort.abort();
        expect(yield* workflows.propose(input, projectCaller, abort.signal)).toEqual({
          choice: "cancelled",
        });
        yield* control.invoke(
          "workflows.start",
          input,
          projectCaller,
          new AbortController().signal,
        );
        yield* drain;
        expect((yield* Ref.get(f.records)).size).toBe(1);
        expect(yield* Queue.size(f.requests)).toBe(0);
      }).pipe(
        Effect.provideService(RendererRequestCoordinator, f.coordinator),
        Effect.provide(f.layer),
      );
    }),
  );
});
