import { it } from "@effect/vitest";
import { Effect, Queue, Schema, Stream } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import type { applicationEventSchema } from "../../../../src/contracts/application/cake-rpc-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { piSettingsSchema } from "../../../../src/contracts/conversations/session-contract";
import { projectPiSettings } from "../../../../src/services/pi/runtime/settings-translation";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { observeApplicationEvents } from "../../../../src/renderer/observers/application-events";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

afterEach(() => vi.useRealTimers());

// Infrastructure integration: keep the real observer, routing and Store policy;
// replace only the incoming transport and outgoing native-notification service.
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
    const client = observerClient({ events });
    const cancel = observeApplicationEvents(observerRuntime(client), fixture.root);
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
    const setError = vi.spyOn(fixture.root.projectWorkbenchStore, "setError");
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
    expect(setError).not.toHaveBeenCalled();
  });

  it.effect.each([undefined, "session-1"])(
    "keeps authentication secrets in the real provider Store and redacts session toasts (session %s)",
    (sessionId) =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const showNotification = vi.fn<Client["electron"]["showNotification"]>(
          async () => undefined,
        );
        using fixture = createRendererStoreFixture({ client: { electron: { showNotification } } });
        const authNotice = {
          type: "provider-auth-notice" as const,
          provider: "test-provider",
          notice: {
            type: "device_code" as const,
            verificationUri: "https://auth.example/device",
            userCode: "SECRET-CODE",
          },
        };
        const event = sessionId ? { ...authNotice, sessionId } : authNotice;
        const runtime = observerRuntime(
          observerClient({
            events: { application: () => Stream.make(event).pipe(Stream.concat(Stream.never)) },
          }),
        );
        const cancel = observeApplicationEvents(runtime, fixture.root);
        try {
          expect(yield* Queue.take(runtime.consumed)).toEqual(event);
          expect(fixture.root.settingsStore.providers.authNotices["test-provider"]).toEqual(
            event.notice,
          );
          if (sessionId) {
            expect(fixture.root.toastStore.toasts).toEqual([
              expect.objectContaining({
                title: "Provider authentication",
                message: "Open Settings → Providers to continue authentication on this device.",
                coalesceKey: "provider-auth:test-provider",
              }),
            ]);
          } else expect(fixture.root.toastStore.toasts).toEqual([]);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(3_000));
          expect(showNotification).not.toHaveBeenCalled();
          expect(JSON.stringify(fixture.root.toastStore.toasts)).not.toContain("SECRET-CODE");
        } finally {
          cancel();
          yield* Effect.promise(() => runtime.dispose());
        }
      }),
  );

  it.effect(
    "routes ordered notifications through real batching policy and ignores events after cancellation",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const showNotification = vi.fn<Client["electron"]["showNotification"]>(
          async () => undefined,
        );
        using fixture = createRendererStoreFixture({ client: { electron: { showNotification } } });
        const events = yield* Queue.unbounded<typeof applicationEventSchema.Type>();
        const runtime = observerRuntime(
          observerClient({
            events: { application: () => Stream.fromQueue(events) },
          }),
        );
        const cancel = observeApplicationEvents(runtime, fixture.root);
        try {
          for (const message of ["Build starting", "Input is required."]) {
            const event: typeof applicationEventSchema.Type = {
              type: "notification",
              tone: "warning",
              title: "Build waiting",
              message,
            };
            yield* Queue.offer(events, event);
            expect(yield* Queue.take(runtime.consumed)).toEqual(event);
          }
          expect(showNotification).not.toHaveBeenCalled();
          expect(fixture.root.toastStore.toasts).toEqual([]);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(3_000));
          expect(showNotification).toHaveBeenCalledExactlyOnceWith(
            {
              title: "Build waiting",
              body: "Input is required.",
              level: "warning",
              id: "cake-agent:cake-agent",
              groupId: "cake-agent:cake-agent",
            },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          );
          expect(fixture.root.toastStore.toasts).toEqual([
            expect.objectContaining({
              title: "Build waiting",
              message: "Input is required.",
              tone: "warning",
            }),
          ]);
          cancel();
          yield* Effect.promise(() => runtime.dispose());
          yield* Queue.offer(events, {
            type: "notification",
            tone: "error",
            title: "Late",
            message: "Must not arrive",
          });
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(3_000));
          expect(showNotification).toHaveBeenCalledTimes(1);
          expect(fixture.root.toastStore.toasts.some((toast) => toast.title === "Late")).toBe(
            false,
          );
        } finally {
          cancel();
          yield* Effect.promise(() => runtime.dispose());
        }
      }),
  );
});
