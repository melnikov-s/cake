import { Effect, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { applicationEventSchema } from "../../../../src/contracts/application/cake-rpc-contract";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { observeApplicationEvents } from "../../../../src/renderer/observers/application-events";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

// Native intake regression: receipt deduplication and suppressed late native replies
// have no honest React action. Notice/settings behavior lives in the workflow suite.
describe("observeApplicationEvents", () => {
  it("has one native request intake, never replays duplicates, and stops late widget replies on disposal", async () => {
    const events = Effect.runSync(Queue.unbounded<typeof applicationEventSchema.Type>());
    const enter = vi.fn<CakeIpcClientService["browser"]["native-browser-enter"]>(() =>
      Effect.succeed({}),
    );
    const browserReply = vi.fn<CakeIpcClientService["browser"]["respond-browser-native"]>(() =>
      Effect.succeed({}),
    );
    let finishCapture!: (value: { pngBase64: string; diagnostics: string[] }) => void;
    const capture = vi.fn<CakeIpcClientService["widgets"]["capture-native-widget"]>(() =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            finishCapture = resolve;
          }),
      ),
    );
    const widgetReply = vi.fn<CakeIpcClientService["widgets"]["respond-widget-capture"]>(() =>
      Effect.succeed({}),
    );
    const application = vi.fn(() => Stream.fromQueue(events));
    const client = observerClient({
      events: { application },
      browser: { "native-browser-enter": enter, "respond-browser-native": browserReply },
      widgets: { "capture-native-widget": capture, "respond-widget-capture": widgetReply },
    });
    using fixture = createRendererStoreFixture();
    const root = fixture.root;
    const stop = observeApplicationEvents(observerRuntime(client), root);
    const request: Extract<
      typeof applicationEventSchema.Type,
      { type: "browser-native-requested" }
    > = {
      type: "browser-native-requested",
      requestId: "00000000-0000-4000-8000-000000000001",
      sessionId: "session",
      workspacePath: "/project",
      operation: "enter",
    };
    Queue.offerUnsafe(events, request);
    Queue.offerUnsafe(events, request);
    await vi.waitFor(() => expect(browserReply).toHaveBeenCalledTimes(1));
    Queue.offerUnsafe(events, request);
    Queue.offerUnsafe(events, {
      type: "widget-capture-requested",
      requestId: "00000000-0000-4000-8000-000000000002",
      sessionId: "session",
      widget: { token: "token", url: "cake-widget://token" },
      pluginState: { version: 9 },
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(application).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledTimes(1);
    stop();
    finishCapture({ pngBase64: "late-native-result", diagnostics: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(widgetReply).not.toHaveBeenCalled();
    expect(root.projectWorkbenchStore.error).toBeUndefined();
  });
});
