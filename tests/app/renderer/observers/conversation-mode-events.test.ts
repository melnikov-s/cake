/** @vitest-environment jsdom */
import { it } from "@effect/vitest";
import { speechOutputSettings } from "../../../helpers/speech-output";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect, Queue } from "effect";
import { createElement } from "react";
import { afterEach, describe, expect, vi } from "vitest";
import { detectFixtureSpeech } from "../../../helpers/speech-detection";
import { TurnId } from "../../../../src/ipc/conversation-data";
import type { CakeEvent } from "../../../../src/ipc/cake-rpc-contract";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import type { UiPart } from "../../../../src/ipc/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { Chat } from "../../../../src/renderer/components/chat";
import type { Microphone } from "../../../../src/renderer/dictation/microphone";
import { observeApplicationEvents } from "../../../../src/renderer/observers/application-events";
import { observeStream } from "../../../../src/renderer/observers/observe-stream";
import { applyConversationUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import type { Runtime } from "../../../../src/renderer/runtime";
import type { SpeechPlayback } from "../../../../src/renderer/speech/playback";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

/** Only the transport and audio/provider boundaries are replaced. Event routing,
 * application observer, shared Chat and the entire Root/Model/Store tree are real. */
async function workflow(events: ClientEvents["Service"]) {
  const consumed = Effect.runSync(Queue.unbounded<unknown>());
  const released = Effect.runSync(Queue.unbounded<void>());
  const recognitionStarted = Effect.runSync(Queue.unbounded<AbortSignal | undefined>());
  const synthesisStarted = Effect.runSync(Queue.unbounded<AbortSignal | undefined>());
  const recognitionDone = Effect.runSync(Deferred.make<void>());
  const synthesisDone = Effect.runSync(Deferred.make<void>());
  let audio: ((samples: Float32Array) => void) | undefined;
  let lateAudio: Parameters<Client["speechOutput"]["synthesize"]>[1] | undefined;
  const stopCapture = vi.fn();
  const microphone: Microphone = {
    open: vi.fn(async (onAudio) => {
      audio = onAudio;
      return { stop: stopCapture, finish: async () => {} };
    }),
    devices: async () => [],
  };
  const playback: SpeechPlayback = {
    start: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000001"),
  );
  const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => {});
  const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async (_request, options) => {
    Queue.offerUnsafe(recognitionStarted, options?.signal);
    await Effect.runPromise(Deferred.await(recognitionDone));
    return "Late recognized words";
  });
  const synthesize = vi.fn<Client["speechOutput"]["synthesize"]>(
    async (_request, consume, options) => {
      lateAudio = consume;
      await consume({ encoding: "pcm_s16le", sampleRate: 24000, pcm: "AAA=" });
      Queue.offerUnsafe(synthesisStarted, options?.signal);
      await Effect.runPromise(Deferred.await(synthesisDone));
    },
  );
  const release = vi.fn(async () => {
    Queue.offerUnsafe(released, undefined);
  });
  const fixture = createRendererStoreFixture({
    microphone,
    speechPlayback: playback,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "one", projectPath: "/project" })],
    client: {
      dictation: {
        prepare: async () => {},
        release,
        transcribe,
        detectSpeech: detectFixtureSpeech,
      },
      speechOutput: { synthesize },
      sessionChats: { prompt, abort },
    },
  });
  const { root } = fixture;
  root.speechSettingsStore.applySettings({
    ...speechOutputSettings(),
    keyConfigured: true,
    voiceId: "voice",
    modelId: "eleven_flash_v2_5",
    speed: 1,
    voices: [],
  });
  const session = root.sessionRegistry.load("one", "/project");
  root.appShellStore.selectProjectSession("one");
  root.projectWorkbenchStore.showLoadedSession("one");
  let revision = 0;
  const publish = (parts: UiPart[]) =>
    act(() =>
      applyConversationUpdate(session.model, {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: {
          sessionId: "one",
          sessionFile: "/project/one.jsonl",
          parts,
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: true,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      }),
    );
  publish([]);
  const view = render(
    createElement(Chat, {
      store: session.conversationSessionStore.chatStore,
      embedded: true,
      composerFocusEnabled: false,
    }),
  );
  const user = userEvent.setup();
  // The typed transport fixture exposes all event channels; only application is used.
  // Unused RPC groups are deliberately absent at this external test boundary.
  const rpc = {
    events: {
      application: () => events.application(1),
      artifacts: () => events.artifacts(1),
      terminals: () => events.terminals(1),
      vscode: () => events.vscode(1),
      surfaces: () => events.surfaces(1),
    },
  } satisfies Pick<CakeIpcClientService, "events">;
  let finished: Promise<unknown> = Promise.resolve();
  const execute: Runtime["execute"] = (effect, signal) => {
    const result = Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, rpc as unknown as CakeIpcClientService),
      signal ? { signal } : undefined,
    );
    finished = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const runtime: Runtime = {
    execute,
    observe: (source, consume, options) =>
      observeStream(
        execute,
        source,
        (event) => {
          consume(event);
          Queue.offerUnsafe(consumed, event);
        },
        options,
      ),
    dispose: async () => {},
  };
  const cancel = observeApplicationEvents(runtime, root);
  expect(await Effect.runPromise(Queue.take(consumed))).toEqual({
    type: "renderer-events-ready",
    channel: "application",
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    view.unmount();
    fixture[Symbol.dispose]();
    Effect.runSync(Deferred.succeed(recognitionDone, undefined));
    Effect.runSync(Deferred.succeed(synthesisDone, undefined));
  };
  return {
    root,
    playback,
    prompt,
    abort,
    stopCapture,
    release,
    transcribe,
    synthesize,
    publish,
    recognitionStarted,
    synthesisStarted,
    released,
    async enter() {
      await user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
      expect(root.conversationModeStore.phase).toBe("active");
      // Enter's mutual-exclusion intent first releases Dictation. Observe only the
      // subsequent conversation resources in these native-blur assertions.
      for (let i = 0; i < release.mock.calls.length; i++)
        await Effect.runPromise(Queue.take(released));
      release.mockClear();
    },
    async frames(value: number, count: number) {
      await act(async () => {
        for (let i = 0; i < count; i++) audio?.(new Float32Array(1600).fill(value));
      });
    },
    async dispatch(event: CakeEvent) {
      expect(events.sendTo(1, event)).toBe(true);
      await act(async () => {
        expect(await Effect.runPromise(Queue.take(consumed))).toEqual(event);
      });
    },
    async settleLate() {
      await act(async () => {
        Effect.runSync(Deferred.succeed(recognitionDone, undefined));
        Effect.runSync(Deferred.succeed(synthesisDone, undefined));
        await lateAudio?.({ encoding: "pcm_s16le", sampleRate: 24000, pcm: "AAA=" });
      });
    },
    async stopObservation() {
      cancel();
      await finished;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

afterEach(cleanup);

describe("conversation-mode native application events", () => {
  it.effect(
    "native_window_blur_releases_capture_recognition_synthesis_and_playback_without_cancelling_pi",
    () =>
      Effect.gen(function* () {
        const events = yield* ClientEvents;
        yield* Effect.promise(async () => {
          using f = await workflow(events);
          await f.enter();
          await f.frames(0.1, 8);
          const recognition = await Effect.runPromise(Queue.take(f.recognitionStarted));
          await f.frames(0, 10);
          f.publish([
            {
              id: "consumed",
              entryId: "consumed",
              kind: "text",
              role: "user",
              text: "Typed request",
              status: "complete",
            },
            {
              id: "reply",
              renderKey: "reply",
              kind: "text",
              role: "assistant",
              text: "A live spoken reply. ",
              status: "streaming",
            },
          ]);
          const synthesis = await Effect.runPromise(Queue.take(f.synthesisStarted));
          expect(recognition?.aborted).toBe(false);
          expect(synthesis?.aborted).toBe(false);
          expect(f.playback.enqueue).toHaveBeenCalledTimes(1);
          const stops = vi.mocked(f.playback.stop).mock.calls.length;
          await f.dispatch({ type: "window-blurred" });
          expect(screen.getByRole("button", { name: "Enter conversation mode" })).toBeDefined();
          expect(f.root.conversationModeStore.phase).toBe("off");
          expect(f.stopCapture).toHaveBeenCalledTimes(1);
          expect(f.playback.stop).toHaveBeenCalledTimes(stops + 1);
          expect(recognition?.aborted).toBe(true);
          expect(synthesis?.aborted).toBe(true);
          await Effect.runPromise(Queue.take(f.released));
          expect(f.release).toHaveBeenCalledTimes(1);
          await f.settleLate();
          await f.frames(0.1, 12);
          expect(f.transcribe).toHaveBeenCalledTimes(1);
          expect(f.playback.enqueue).toHaveBeenCalledTimes(1);
          expect(f.prompt).not.toHaveBeenCalled();
          expect(f.abort).not.toHaveBeenCalled();
          expect(f.root.conversationModeStore.phase).toBe("off");
        });
      }).pipe(Effect.provide(ClientEventsLive)),
  );
  it.effect("non_blur_application_events_do_not_exit_conversation_mode", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      yield* Effect.promise(async () => {
        using f = await workflow(events);
        await f.enter();
        const stops = vi.mocked(f.playback.stop).mock.calls.length;
        await f.dispatch({
          type: "application-hotkey-input",
          key: "Shift",
          code: "ShiftLeft",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
          repeat: false,
          isComposing: false,
        });
        expect(f.root.conversationModeStore.phase).toBe("active");
        expect(screen.getByRole("button", { name: "Exit conversation mode" })).toBeDefined();
        expect(f.stopCapture).not.toHaveBeenCalled();
        expect(f.playback.stop).toHaveBeenCalledTimes(stops);
        expect(f.release).not.toHaveBeenCalled();
        await f.dispatch({ type: "window-blurred" });
        expect(f.root.conversationModeStore.phase).toBe("off");
        await Effect.runPromise(Queue.take(f.released));
        expect(f.release).toHaveBeenCalledTimes(1);
        expect(f.abort).not.toHaveBeenCalled();
      });
    }).pipe(Effect.provide(ClientEventsLive)),
  );
  it.effect("cancelled_event_observation_does_not_reenter_or_mutate_disposed_mode", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      yield* Effect.promise(async () => {
        using first = await workflow(events);
        await first.enter();
        await first.stopObservation();
        expect(events.sendTo(1, { type: "window-blurred" })).toBe(false);
        expect(first.root.conversationModeStore.phase).toBe("active");
        const mode = first.root.conversationModeStore;
        first.dispose();
        await Effect.runPromise(Queue.take(first.released));
        const stopped = {
          phase: mode.phase,
          sessionId: mode.sessionId,
          listening: mode.listening,
          speaking: mode.speaking,
        };
        expect(stopped).toEqual({
          phase: "off",
          sessionId: undefined,
          listening: false,
          speaking: false,
        });
        using reconnected = await workflow(events);
        await reconnected.enter();
        await reconnected.dispatch({ type: "window-blurred" });
        expect(reconnected.root.conversationModeStore.phase).toBe("off");
        await reconnected.settleLate();
        await first.frames(0.1, 12);
        expect({
          phase: mode.phase,
          sessionId: mode.sessionId,
          listening: mode.listening,
          speaking: mode.speaking,
        }).toEqual(stopped);
        expect(first.stopCapture).toHaveBeenCalledTimes(1);
        expect(first.release).toHaveBeenCalledTimes(1);
        expect(first.prompt).not.toHaveBeenCalled();
        expect(first.abort).not.toHaveBeenCalled();
      });
    }).pipe(Effect.provide(ClientEventsLive)),
  );
});
