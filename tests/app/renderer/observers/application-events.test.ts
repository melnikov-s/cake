import { Effect, Stream } from "effect";
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
