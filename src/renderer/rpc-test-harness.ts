import { Option, Schema } from "effect";
import { makeCakeIpcPromiseClient } from "../ipc/client/CakeIpcClient";
import { FoundationFailure } from "../ipc/protocol/CakeRpc";

const bridge = window.cake;
if (!bridge) throw new Error("Cake preload bridge is unavailable");

const client = makeCakeIpcPromiseClient(bridge.rpc);
const TaggedFailure = Schema.Struct({ _tag: Schema.String });
let delayController: AbortController | undefined;
let runningDelay: Promise<void> | undefined;
let runningStream: Promise<ReadonlyArray<number>> | undefined;

const harness = {
  getHomeDirectory: () => client.application.getHomeDirectory(),
  getApplicationState: () => client.application.getState(),
  listModels: () => client.models.list(),
  listModelPresets: () => client.modelPresets.list(),
  listProjectSessions: () => client.projectSessions.list(),
  listCakeChats: () => client.cakeChats.list(),
  listDiscussionSessions: () =>
    client.discussionSessions.list({
      workingDirectory: "/tmp/cake-effect-rpc",
      parentSessionId: "rpc-empty-parent",
    }),
  createModelPreset: (input: {
    name: string;
    provider: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    fastMode: boolean;
  }) => client.modelPresets.create(input),
  updateModelPreset: (input: {
    id: string;
    name: string;
    provider: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    fastMode: boolean;
  }) => client.modelPresets.update(input),
  removeModelPreset: (id: string) => client.modelPresets.remove(id),
  setDefaultModelPreset: (id?: string) => client.modelPresets.setDefault(id),
  async resolveModelPresetFailureTag(id: string) {
    try {
      await client.modelPresets.resolve(id);
      return "success";
    } catch (error) {
      const failure = Schema.decodeUnknownOption(TaggedFailure)(error);
      return Option.isSome(failure) ? failure.value._tag : "unknown";
    }
  },
  async typedFailureTag() {
    try {
      await client.foundation.typedFailure();
      return "success";
    } catch (error) {
      return Schema.is(FoundationFailure)(error) ? error._tag : "unknown";
    }
  },
  stream: (count: number, intervalMs: number) => client.foundation.stream({ count, intervalMs }),
  startDelay(durationMs: number) {
    delayController = new AbortController();
    runningDelay = client.foundation.delay(durationMs, delayController.signal);
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
    runningStream = client.foundation.stream({ count, intervalMs });
    void runningStream.catch(() => {});
  },
  activeRequests: () => client.foundation.activeRequests(),
};

Reflect.set(globalThis, "cakeRpcHarness", harness);
window.addEventListener("pagehide", () => {
  void client.dispose();
});
document.documentElement.dataset.rpcReady = "true";
