import { it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import { expect } from "vitest";
import { makeElectronRpcClientProtocol } from "../../../src/ipc/transport/ElectronRpcClientProtocol";

const TestRpc = RpcGroup.make(
  Rpc.make("echo", { payload: { value: Schema.String }, success: Schema.String }),
  Rpc.make("watch", { success: Schema.String, stream: true }),
);

const setup = Effect.fn("ElectronRpcClientProtocolTest.setup")(function* () {
  const sent = yield* Queue.unbounded<FromClientEncoded>();
  let receive: ((message: unknown) => void) | undefined;
  let immediate = false;
  let fail = false;
  const scope = yield* Scope.fork(yield* Effect.scope);
  const context = yield* Layer.buildWithScope(
    makeElectronRpcClientProtocol({
      subscribe: (listener) => {
        receive = listener;
        return () => {
          receive = undefined;
        };
      },
      send: (message) => {
        if (fail) throw new Error("send failed");
        Queue.offerUnsafe(sent, message);
        if (immediate && message._tag === "Request")
          receive?.({
            _tag: "Exit",
            requestId: message.id,
            exit: { _tag: "Success", value: "immediate" },
          });
      },
    }),
    scope,
  );
  return {
    context,
    protocol: Context.get(context, RpcClient.Protocol),
    sent,
    receive: (message: FromServerEncoded) => receive?.(message),
    immediate: () => {
      immediate = true;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    close: () => Scope.close(scope, Exit.void),
    subscribed: () => receive !== undefined,
  };
});

it.effect(
  "routes out-of-order unary and stream responses to distinct generated clients, including synchronous replies",
  () =>
    Effect.gen(function* () {
      const host = yield* setup();
      // Effect allocates process-wide client IDs; neither client is assumed to be zero.
      const a = yield* RpcClient.make(TestRpc).pipe(Effect.provideContext(host.context));
      const b = yield* RpcClient.make(TestRpc).pipe(Effect.provideContext(host.context));
      const first = yield* a.echo({ value: "first" }).pipe(Effect.forkScoped);
      const requestA = yield* Queue.take(host.sent);
      expect(requestA._tag).toBe("Request");
      if (requestA._tag !== "Request") throw new Error("Expected request");
      const second = yield* b.watch().pipe(Stream.runCollect, Effect.forkScoped);
      const requestB = yield* Queue.take(host.sent);
      if (requestB._tag !== "Request") throw new Error("Expected request");
      host.receive({ _tag: "Chunk", requestId: requestB.id, values: ["second"] });
      expect(yield* Queue.take(host.sent)).toEqual({ _tag: "Ack", requestId: requestB.id });
      host.receive({
        _tag: "Exit",
        requestId: requestB.id,
        exit: { _tag: "Success", value: null },
      });
      host.receive({
        _tag: "Exit",
        requestId: requestA.id,
        exit: { _tag: "Success", value: "first" },
      });
      expect(yield* Fiber.join(second)).toEqual(["second"]);
      expect(yield* Fiber.join(first)).toBe("first");
      host.immediate();
      expect(yield* b.echo({ value: "early" })).toBe("immediate");
    }),
);

it.effect(
  "interrupts only its request, ignores late replies, recovers from send failure and unsubscribes on disposal",
  () =>
    Effect.gen(function* () {
      const host = yield* setup();
      const a = yield* RpcClient.make(TestRpc).pipe(Effect.provideContext(host.context));
      const b = yield* RpcClient.make(TestRpc).pipe(Effect.provideContext(host.context));
      const watching = yield* a.watch().pipe(Stream.runCollect, Effect.forkScoped);
      const request = yield* Queue.take(host.sent);
      if (request._tag !== "Request") throw new Error("Expected request");
      yield* Fiber.interrupt(watching);
      expect(yield* Queue.take(host.sent)).toEqual({ _tag: "Interrupt", requestId: request.id });
      host.receive({ _tag: "Chunk", requestId: request.id, values: ["late"] });
      host.receive({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: null } });
      host.fail(true);
      const error = yield* b.echo({ value: "failure" }).pipe(Effect.flip);
      expect(error.reason._tag).toBe("RpcClientDefect");
      host.fail(false);
      host.immediate();
      expect(yield* b.echo({ value: "alive" })).toBe("immediate");
      yield* host.close();
      expect(host.subscribed()).toBe(false);
    }),
);

it.effect("a fatal transport defect retires request routing before later messages arrive", () =>
  Effect.gen(function* () {
    const host = yield* setup();
    const responses = yield* Queue.unbounded<FromServerEncoded>();
    yield* host.protocol
      .run(42, (message) => Queue.offer(responses, message))
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* host.protocol.send(42, {
      _tag: "Request",
      id: "failed",
      tag: "echo",
      payload: { value: "x" },
      headers: [],
    });
    host.receive({ _tag: "Defect", defect: "fatal" });
    expect(yield* Queue.take(responses)).toEqual({ _tag: "Defect", defect: "fatal" });
    host.receive({ _tag: "Chunk", requestId: "failed", values: ["stale"] });
    // A second live response is a deterministic barrier behind the stale message.
    yield* host.protocol.send(42, {
      _tag: "Request",
      id: "new",
      tag: "echo",
      payload: { value: "y" },
      headers: [],
    });
    const completed: FromServerEncoded = {
      _tag: "Exit",
      requestId: "new",
      exit: { _tag: "Success", value: "new" },
    };
    host.receive(completed);
    expect(yield* Queue.take(responses)).toEqual(completed);
  }),
);
