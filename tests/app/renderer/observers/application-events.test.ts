import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { piSettingsSchema } from "../../../../src/contracts/conversations/session-contract";
import { projectPiSettings } from "../../../../src/services/pi/runtime/settings-translation";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { Effect, Queue, Schema, Stream } from "effect";
import type { CakeEvent } from "../../../../src/contracts/application/cake-rpc-contract";
import { describe, expect, it, vi } from "vitest";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { observeApplicationEvents } from "../../../../src/renderer/observers/application-events";
import { observeStream } from "../../../../src/renderer/observers/observe-stream";
import type { Runtime } from "../../../../src/renderer/runtime";
import type { RootStore } from "../../../../src/renderer/stores/RootStore";

const runtimeFor = (client: CakeIpcClientService): Runtime => {
  const execute: Runtime["execute"] = (effect, signal) =>
    Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, client),
      signal ? { signal } : undefined,
    );
  return {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: async () => undefined,
  };
};

describe("observeApplicationEvents", () => {
  it("projects backend Pi settings and attributed mutation notices into the real renderer Stores", async () => {
    using fixture = createRendererStoreFixture();
    const settings = Schema.decodeUnknownSync(piSettingsSchema)(
      projectPiSettings(
        SettingsManager.fromStorage(
          {
            withLock(_scope, update) {
              update("{}");
            },
          },
          { projectTrusted: true },
        ),
      ),
    );
    const show = vi.spyOn(fixture.root.toastStore, "show");
    const notice = {
      type: "agent-action-notice" as const,
      source: { kind: "project-session" as const, sessionId: "source", title: "Source" },
      message: "Updated Cake Project settings",
      coalesceKey: "project-settings:/project",
    };
    const events: CakeIpcClientService["events"] = {
      artifacts: () => Stream.never,
      terminals: () => Stream.never,
      vscode: () => Stream.never,
      surfaces: () => Stream.never,
      application: () =>
        Stream.concat(
          Stream.make({ type: "pi-settings-changed" as const, settings }, notice),
          Stream.never,
        ),
    };
    // SAFETY: This test stream exercises only events.application; all Store behavior is real.
    const client = { events } as CakeIpcClientService;
    const cancel = observeApplicationEvents(runtimeFor(client), fixture.root);
    try {
      await vi.waitFor(() => {
        expect(fixture.root.settingsStore.providers.piSettings).toEqual(settings);
        expect(show).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Agent action · Source",
            message: notice.message,
            coalesceKey: "agent:source:project-settings:/project",
          }),
        );
      });
    } finally {
      cancel();
    }
  });

  it("has one native request intake, never replays duplicates, and stops late widget replies on disposal", async () => {
    const events = Effect.runSync(Queue.unbounded<CakeEvent>());
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
    const client = {
      events: { application },
      browser: { "native-browser-enter": enter, "respond-browser-native": browserReply },
      widgets: { "capture-native-widget": capture, "respond-widget-capture": widgetReply },
    } as unknown as CakeIpcClientService;
    const setError = vi.fn();
    const root = { projectWorkbenchStore: { setError } } as unknown as RootStore;
    const stop = observeApplicationEvents(runtimeFor(client), root);
    const request: Extract<CakeEvent, { type: "browser-native-requested" }> = {
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
    expect(setError).not.toHaveBeenCalled();
  });

  it.each([undefined, "session-1"])(
    "keeps auth details in the provider Store (session %s)",
    async (sessionId) => {
      const receiveAuthNotice = vi.fn();
      const show = vi.fn();
      const enqueue = vi.fn();
      const event = {
        type: "provider-auth-notice" as const,
        provider: "test-provider",
        ...(sessionId ? { sessionId } : {}),
        notice: {
          type: "device_code" as const,
          verificationUri: "https://auth.example/device",
          userCode: "SECRET-CODE",
        },
      };
      const client = {
        events: { application: () => Stream.concat(Stream.make(event), Stream.never) },
      } as unknown as CakeIpcClientService;
      const root = {
        settingsStore: { providers: { receiveAuthNotice } },
        toastStore: { show },
        notificationStore: { enqueue },
      } as unknown as RootStore;
      const cancel = observeApplicationEvents(runtimeFor(client), root);
      try {
        await vi.waitFor(() => expect(receiveAuthNotice).toHaveBeenCalledWith(event));
        expect(enqueue).not.toHaveBeenCalled();
        if (sessionId) {
          expect(show).toHaveBeenCalledWith({
            title: "Provider authentication",
            message: "Open Settings → Providers to continue authentication on this device.",
            coalesceKey: "provider-auth:test-provider",
          });
        } else {
          expect(show).not.toHaveBeenCalled();
        }
      } finally {
        cancel();
      }
    },
  );

  it("delivers notification events through macOS native notifications", async () => {
    const enqueue = vi.fn(async () => undefined);
    const showToast = vi.fn();
    const client = {
      events: {
        application: () =>
          Stream.concat(
            Stream.make({
              type: "notification" as const,
              tone: "warning" as const,
              title: "Build waiting",
              message: "Input is required.",
            }),
            Stream.never,
          ),
      },
    } as unknown as CakeIpcClientService;
    const root = {
      notificationStore: { enqueue },
      toastStore: { show: showToast },
    } as unknown as RootStore;

    const cancel = observeApplicationEvents(runtimeFor(client), root);

    await vi.waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith({
        title: "Build waiting",
        body: "Input is required.",
        level: "warning",
      }),
    );
    expect(showToast).not.toHaveBeenCalled();
    cancel();
  });
});
