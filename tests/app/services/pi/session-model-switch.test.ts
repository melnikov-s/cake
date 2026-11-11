import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../../src/services/pi/CakeSessionRuntimes";
import {
  fakeRuntime,
  makeRuntimeRecoveryStorageTestLayer,
  options,
  snapshot,
} from "../../helpers/piRuntimeFixture";
import type { CakeSessionRuntimeOptions } from "../../../../src/services/pi/runtime/cake-session-runtime";
import type { ChatConfiguration } from "../../../../src/contracts/conversations/session-contract";

const configuration: ChatConfiguration = {
  provider: "fixture",
  modelId: "new",
  thinkingLevel: "off",
  fastMode: false,
};
const fixture = Effect.fn("ModelSwitchTest.fixture")(function* (active = false) {
  const events: string[] = [];
  const started = yield* Queue.unbounded<string>();
  const cleanup = yield* Deferred.make<void>();
  const receipt = yield* Deferred.make<void>();
  const promptRelease = yield* Deferred.make<void>();
  let holdPrompt = false;
  let activeId: string | undefined;
  let running = active;
  let toolFinished = false;
  const parts = (): typeof snapshot.parts =>
    toolFinished
      ? [
          {
            id: "tool-self",
            kind: "tool",
            name: "cake",
            input: "",
            output: "accepted",
            state: "success",
          },
        ]
      : [];
  let holdCleanup = false;
  let fail: string | undefined;
  let runtimeOptions: CakeSessionRuntimeOptions | undefined;
  const queued = { steering: ["Human correction"], followUp: ["Human next task"] };
  const layer = makeCakeSessionRuntimesLayer({
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    changelog: () => Effect.succeed(""),
    createRuntime: (input) =>
      Effect.sync(() => {
        runtimeOptions = input;
        return {
          ...fakeRuntime(input, () => undefined),
          get streaming() {
            return running;
          },
          snapshot: async () => ({ ...snapshot, streaming: running, parts: parts() }),
          listQueuedMessages: async () => queued,
          abort: async () => {
            events.push("stop");
            if (fail === "stop") throw new Error("stop failed");
            running = false;
          },
          waitForStop: async () => {
            events.push("join");
            Deferred.doneUnsafe(receipt, Effect.void);
            if (holdCleanup) await Effect.runPromise(Deferred.await(cleanup));
            if (fail === "join") throw new Error("cleanup failed");
            events.push("terminated");
          },
          applyConfiguration: async () => {
            events.push("configure");
            if (fail === "configure") throw new Error("configure failed");
          },
          executingTurnIds: () => (activeId ? [activeId] : []),
          prompt: async (text, _delivery, _attachments, _markdown, turnId) => {
            activeId = turnId;
            events.push(text);
            await Effect.runPromise(Queue.offer(started, text));
            if (holdPrompt) await Effect.runPromise(Deferred.await(promptRelease));
            activeId = undefined;
          },
        };
      }),
  }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
  return {
    layer,
    events,
    started,
    cleanup,
    receipt,
    queued,
    promptRelease,
    holdPrompt: () => {
      holdPrompt = true;
    },
    hold: () => {
      holdCleanup = true;
    },
    fail: (stage: string) => {
      fail = stage;
    },
    finishNaturally: () => {
      running = false;
    },
    toolResult: () => {
      toolFinished = true;
      runtimeOptions?.onEvent({
        type: "snapshot",
        snapshot: { ...snapshot, streaming: true, parts: parts() },
      });
    },
  };
});

describe("session model handoff", () => {
  it.effect("idle changes configuration without a Continue or queue mutation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const handle = yield* (yield* CakeSessionRuntimes).acquire(options());
        const result = yield* handle.switchModel(configuration);
        expect(result).toMatchObject({ status: "changed", stage: "complete" });
        expect(result.turnId).toBeUndefined();
        expect(f.events).toEqual(["join", "terminated", "configure"]);
        expect(yield* handle.listQueuedMessages()).toEqual(f.queued);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("active joins actual cleanup before switching and admitting exactly one Continue", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      f.hold();
      yield* Effect.gen(function* () {
        const sessions = yield* CakeSessionRuntimes;
        const handle = yield* sessions.acquire(options());
        const pending = yield* handle.switchModel(configuration).pipe(Effect.forkChild);
        yield* Deferred.await(f.receipt);
        expect(f.events).toEqual(["stop", "join"]);
        // A different acquired handle shares the same handoff reservation.
        const other = yield* sessions.acquireSession("session-1");
        const duplicate = yield* other.switchModel(configuration).pipe(Effect.result);
        expect(duplicate._tag).toBe("Failure");
        const human = yield* handle.prompt("New human input").pipe(Effect.forkChild);
        expect(f.events).not.toContain("New human input");
        yield* Deferred.succeed(f.cleanup, undefined);
        const result = yield* Fiber.join(pending);
        expect(result).toMatchObject({ status: "continued", stage: "complete" });
        expect(result.turnId).toBeTypeOf("string");
        yield* Fiber.join(human);
        expect(f.events.slice(0, 5)).toEqual([
          "stop",
          "join",
          "terminated",
          "configure",
          "Continue.",
        ]);
        expect(f.events.filter((event) => event === "Continue.")).toHaveLength(1);
        expect(yield* handle.listQueuedMessages()).toEqual(f.queued);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  for (const failure of ["stop", "join", "configure"] as const) {
    it.effect(`reports ${failure} failure without claiming success or continuing`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        f.fail(failure);
        yield* Effect.gen(function* () {
          const handle = yield* (yield* CakeSessionRuntimes).acquire(options());
          const result = yield* handle.switchModel(configuration);
          expect(result).toMatchObject({
            status: "failed",
            stage: failure === "configure" ? "configure" : "stop",
          });
          expect(result.error).toMatch(/failed/);
          expect(f.events).not.toContain("Continue.");
          if (failure !== "configure") expect(f.events).not.toContain("configure");
          expect(yield* handle.modelSwitchStatus()).toEqual(result);
        }).pipe(Effect.provide(f.layer));
      }),
    );
  }

  it.effect("failed abort retains ownership of the original accepted turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.holdPrompt();
      f.fail("stop");
      yield* Effect.gen(function* () {
        const handle = yield* (yield* CakeSessionRuntimes).acquire(options());
        const original = yield* handle.prompt("Original");
        yield* Queue.take(f.started);
        expect((yield* handle.switchModel(configuration)).status).toBe("failed");
        expect(yield* handle.currentTurnIds()).toContain(original);
        yield* Deferred.succeed(f.promptRelease, undefined);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("self returns accepted, waits for its own tool result, then switches", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* Effect.gen(function* () {
        const handle = yield* (yield* CakeSessionRuntimes).acquire(options());
        const accepted = yield* handle.switchModel(configuration, "self");
        expect(accepted).toMatchObject({ status: "accepted", stage: "receipt" });
        expect(f.events).toEqual([]);
        f.toolResult();
        expect(yield* Queue.take(f.started)).toBe("Continue.");
        const status = yield* handle.modelSwitchStatus();
        expect(status?.operationId).toBe(accepted.operationId);
        expect(["switching", "continued"]).toContain(status?.status);
        expect(f.events).toEqual(["stop", "join", "terminated", "configure", "Continue."]);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("missing self tool receipt fails truthfully without stopping work", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* Effect.gen(function* () {
        const handle = yield* (yield* CakeSessionRuntimes).acquire(options());
        expect((yield* handle.switchModel(configuration, "missing")).status).toBe("accepted");
        yield* TestClock.adjust("1 minute");
        expect(yield* handle.modelSwitchStatus()).toMatchObject({
          status: "failed",
          stage: "receipt",
        });
        expect(f.events).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("reports Continue admission failure after a successful configuration", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* Effect.gen(function* () {
        const handle = yield* (yield* CakeSessionRuntimes).acquire({
          ...options(),
          admitTurn: () => Effect.fail(new Error("Continue admission failed")),
        });
        expect(yield* handle.switchModel(configuration)).toMatchObject({
          status: "failed",
          stage: "continue",
          error: expect.stringContaining("admission failed"),
        });
        expect(f.events).toEqual(["stop", "join", "terminated", "configure"]);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  for (const profile of [
    "ProjectSession",
    "AutomationSession",
    "DiscussionSession",
    "CakeChatSession",
  ] as const) {
    it.effect(`supports the ${profile} runtime profile`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const handle = yield* (yield* CakeSessionRuntimes).acquire({
            ...options(
              profile === "CakeChatSession"
                ? { globalControl: { tools: [], invoke: async () => ({}) } }
                : {},
            ),
            profile: { _tag: profile },
          });
          expect((yield* handle.switchModel(configuration)).status).toBe("changed");
        }).pipe(Effect.provide(f.layer));
      }),
    );
  }

  it.effect("a naturally finished target is configured without restarting", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* Effect.gen(function* () {
        const handle = yield* (yield* CakeSessionRuntimes).acquire(options());
        f.finishNaturally();
        expect((yield* handle.switchModel(configuration)).status).toBe("changed");
        expect(f.events).not.toContain("stop");
        expect(f.events).not.toContain("Continue.");
      }).pipe(Effect.provide(f.layer));
    }),
  );
});
