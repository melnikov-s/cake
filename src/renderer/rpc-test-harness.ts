import { Effect, Option, Schema, Stream } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import { FoundationFailure } from "../ipc/protocol/CakeRpc";
import {
  privilegedRequestSchema,
  type PrivilegedRequest,
  type PrivilegedRouteType,
} from "../ipc/privileged-contract";
import { makeRendererRuntime } from "./RendererRuntime";

const bridge = window.cake;
if (!bridge) throw new Error("Cake preload bridge is unavailable");

const runtime = makeRendererRuntime(bridge.rpc);
const withClient = <Success, Failure>(
  operation: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
) => Effect.flatMap(CakeIpcClient, operation);
const run = <Success, Failure>(
  effect: Effect.Effect<Success, Failure, CakeIpcClient>,
  signal?: AbortSignal,
) => runtime.runPromise(effect, signal ? { signal } : undefined);
const collect = <Value, Failure>(
  stream: Stream.Stream<Value, Failure, CakeIpcClient>,
): Promise<ReadonlyArray<Value>> => run(Stream.runCollect(stream));

const TaggedFailure = Schema.Struct({ _tag: Schema.String });
let delayController: AbortController | undefined;
let runningDelay: Promise<void> | undefined;
let runningStream: Promise<ReadonlyArray<number>> | undefined;

type RoutedPrivilegedRequest = Extract<PrivilegedRequest, { type: PrivilegedRouteType }>;

const harness = {
  invokePrivileged: (input: PrivilegedRequest) => {
    const parsed = Schema.decodeUnknownSync(privilegedRequestSchema)(input);
    return run(
      withClient((client) => {
        if (!(parsed.type in client.privileged))
          throw new Error(`The RPC test harness cannot invoke ${parsed.type}`);
        // SAFETY: membership in the generated route map proves this parsed request is routable.
        const request = parsed as RoutedPrivilegedRequest;
        // SAFETY: the route key and request discriminant are correlated by RoutedPrivilegedRequest.
        return client.privileged[request.type](request as never);
      }),
    );
  },
  getHomeDirectory: () => run(withClient((client) => client.application.getHomeDirectory())),
  getApplicationState: () => run(withClient((client) => client.application.getState())),
  listModels: () => run(withClient((client) => client.models.list())),
  listModelPresets: () => run(withClient((client) => client.modelPresets.list())),
  listProjectSessions: () => run(withClient((client) => client.projectSessions.list())),
  listCakeChats: () => run(withClient((client) => client.cakeChats.list())),
  invokeElectronProbe: () =>
    run(
      withClient((client) =>
        client.privileged["set-fullscreen-surface-open"]({
          type: "set-fullscreen-surface-open",
          requestId: crypto.randomUUID(),
          surfaceId: crypto.randomUUID(),
          open: false,
        }),
      ),
    ),
  privilegedReady: () =>
    collect(
      Stream.unwrap(Effect.map(CakeIpcClient, (client) => client.privileged.observe())).pipe(
        Stream.take(1),
      ),
    ).then(([event]) => event),
  listDiscussionSessions: () =>
    run(
      withClient((client) =>
        client.discussionSessions.list({
          workingDirectory: "/tmp/cake-effect-rpc",
          parentSessionId: "rpc-empty-parent",
        }),
      ),
    ),
  createModelPreset: (input: {
    name: string;
    provider: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    fastMode: boolean;
  }) => run(withClient((client) => client.modelPresets.create(input))),
  updateModelPreset: (input: {
    id: string;
    name: string;
    provider: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    fastMode: boolean;
  }) => run(withClient((client) => client.modelPresets.update(input))),
  removeModelPreset: (id: string) => run(withClient((client) => client.modelPresets.remove(id))),
  setDefaultModelPreset: (id?: string) =>
    run(withClient((client) => client.modelPresets.setDefault(id))),
  async resolveModelPresetFailureTag(id: string) {
    try {
      await run(withClient((client) => client.modelPresets.resolve(id)));
      return "success";
    } catch (error) {
      const failure = Schema.decodeUnknownOption(TaggedFailure)(error);
      return Option.isSome(failure) ? failure.value._tag : "unknown";
    }
  },
  async typedFailureTag() {
    try {
      await run(withClient((client) => client.foundation.typedFailure()));
      return "success";
    } catch (error) {
      return Schema.is(FoundationFailure)(error) ? error._tag : "unknown";
    }
  },
  stream: (count: number, intervalMs: number) =>
    collect(
      Stream.unwrap(
        Effect.map(CakeIpcClient, (client) => client.foundation.stream({ count, intervalMs })),
      ),
    ),
  startDelay(durationMs: number) {
    delayController = new AbortController();
    runningDelay = run(
      withClient((client) => client.foundation.delay({ durationMs })),
      delayController.signal,
    );
    void runningDelay.catch(() => {});
  },
  cancelDelay() {
    delayController?.abort();
  },
  async waitForDelay() {
    try {
      await runningDelay;
      return "completed";
    } catch {
      return "interrupted";
    }
  },
  startStream(count: number, intervalMs: number) {
    runningStream = collect(
      Stream.unwrap(
        Effect.map(CakeIpcClient, (client) => client.foundation.stream({ count, intervalMs })),
      ),
    );
    void runningStream.catch(() => {});
  },
  activeRequests: () => run(withClient((client) => client.foundation.activeRequests())),
};

Reflect.set(globalThis, "cakeRpcHarness", harness);
window.addEventListener("pagehide", () => {
  void runtime.dispose();
});
document.documentElement.dataset.rpcReady = "true";
