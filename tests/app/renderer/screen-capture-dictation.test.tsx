/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect, Exit, Predicate, Queue, Schema, Stream } from "effect";
import { Rpc } from "effect/rpc";
import type { Client } from "../../../src/renderer/client/Client";
import { ElectronRpc } from "../../../src/ipc/protocol/ElectronRpc";
import {
  CapturePreferences,
  ScreenCaptureSnapshot as SnapshotSchema,
} from "../../../src/contracts/desktop/screen-capture-data";
import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationState } from "../../../src/contracts/dictation/dictation-data";
import type { ScreenCaptureSnapshot } from "../../../src/contracts/desktop/screen-capture-data";
import type { Microphone } from "../../../src/renderer/dictation/microphone";
import { ScreenCaptureOverlay } from "../../../src/renderer/components/screen-capture-overlay";
import { observeDictation } from "../../../src/renderer/observers/dictation";
import { ScreenCaptureOverlayStore } from "../../../src/renderer/stores/ScreenCaptureOverlayStore";
import { installedDictationState } from "../../helpers/dictation";
import { captureRouting } from "../../helpers/screen-capture";
import { observerClient, observerRuntime } from "./observers/observer-test-runtime";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { createTestClient } from "./test-client";

afterEach(cleanup);

function captureSnapshot(muted: boolean): ScreenCaptureSnapshot {
  return {
    routing: {
      ...captureRouting,
      dictation: { ...captureRouting.dictation, enabled: true, muted },
    },
    image: "data:image/png;base64,fixture",
    automaticTopInset: 0,
    width: 1200,
    height: 800,
    maxDimension: 1024,
  };
}

/** Real annotation UI, dictation Store and observer; audio and transport are safe fakes. */
function captureDictation(
  snapshot:
    | ScreenCaptureSnapshot
    | Promise<ScreenCaptureSnapshot>
    | (() => Promise<ScreenCaptureSnapshot>),
) {
  const finishScreenCapture = vi.fn(async () => {});
  const stop = vi.fn();
  const open = vi.fn<Microphone["open"]>(async () => ({
    stop,
    finish: async () => {},
    discardPending: async () => {},
  }));
  const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async () => "Annotation");
  const client = createTestClient({
    dictation: {
      transcribe,
      detectSpeech: async () => true,
      endRound: async () => {},
      prepare: async () => {},
      prepareSpeaker: async () => ({ reused: false }),
      claim: async () => ({ claim: 1 }),
      trace: async () => {},
    },
  });
  const store = mount(
    createStore(ScreenCaptureOverlayStore, {
      client: {
        screenCaptureState: async () => (Predicate.isFunction(snapshot) ? snapshot() : snapshot),
        finishScreenCapture,
      },
      speech: {
        client: client.dictation,
        postProcess: client.workspaces.postProcessDictation,
        microphone: { open, devices: async () => [] },
      },
      renderImage: async () => "data:image/png;base64,export",
      copy: async () => {},
    }),
  );
  const updates = Effect.runSync(Queue.unbounded<DictationState>());
  const runtime = observerRuntime(
    observerClient({ dictation: { observeState: () => Stream.fromQueue(updates) } }),
  );
  const stopObservation = observeDictation(runtime, store.dictationStore);
  const view = render(<ScreenCaptureOverlay store={store} />);
  return {
    store,
    finishScreenCapture,
    open,
    stop,
    transcribe,
    async emit(muted: boolean) {
      await act(async () => {
        Queue.offerUnsafe(updates, { ...installedDictationState, status: "ready", muted });
        await Effect.runPromise(Queue.take(runtime.consumed));
      });
    },
    async initialize() {
      await act(async () => store.initialize());
    },
    async annotate() {
      await act(async () => {
        store.setMode("annotate");
        store.begin({ x: 100, y: 200 });
        store.end({ x: 300, y: 400 });
      });
      await act(async () => screen.getByRole("textbox", { name: "Annotation comment" }).focus());
    },
    async close() {
      stopObservation();
      view.unmount();
      store[Symbol.dispose]();
      await runtime.dispose();
    },
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
}

describe("Capture dictation mute", () => {
  it("decodes an older main's capture response produced from the real originating capture command", async () => {
    // The older main only echoes the fields it knows, stripping the newer options.
    const fields = CapturePreferences.fields.dictation.fields;
    const legacyPreferences = Schema.Struct({
      ...CapturePreferences.fields,
      dictation: Schema.Struct({
        enabled: fields.enabled,
        deviceId: fields.deviceId,
        textProcessingMode: fields.textProcessingMode,
        recognition: fields.recognition,
      }),
    });
    const rpc = ElectronRpc.requests.get("electron.screen-capture-state");
    if (!rpc || rpc._tag !== "electron.screen-capture-state")
      throw new Error("Missing capture RPC");
    let response: unknown;
    using origin = createRendererStoreFixture({
      client: {
        electron: {
          startScreenCapture: async (preferences) => {
            expect(preferences.dictation.muted).toBe(true);
            expect(preferences.dictation.firstSpeaker).toBe(true);
            const wireRouting = Schema.encodeSync(Schema.toCodecJson(CapturePreferences))(
              preferences,
            );
            const routing = Schema.decodeUnknownSync(Schema.toCodecJson(legacyPreferences))(
              wireRouting,
            );
            expect("muted" in routing.dictation).toBe(false);
            const legacySnapshot = Schema.Struct({
              ...SnapshotSchema.fields,
              routing: legacyPreferences,
            });
            response = Schema.encodeSync(
              Schema.toCodecJson(Schema.Exit(legacySnapshot, Schema.Never, Schema.Defect())),
            )(Exit.succeed({ ...captureSnapshot(true), routing }));
            return { annotationColor: preferences.annotationColor };
          },
        },
      },
    });
    origin.root.dictationStore.enabled = true;
    origin.root.dictationStore.muted = true;
    origin.root.speechInputSettingsStore.setDictationFirstSpeaker(true);
    await origin.root.screenCaptureStore.capture();
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(rpc)))(response);
    expect(decoded._tag).toBe("Success");
    if (!Exit.isSuccess(decoded)) throw new Error("Capture response failed");
    expect(decoded.value.routing.dictation.muted).toBeUndefined();
    expect(decoded.value.routing.dictation.firstSpeaker).toBeUndefined();
    await using overlay = captureDictation(decoded.value);
    await overlay.initialize();
    await overlay.annotate();
    expect(overlay.store.dictationStore.muted).toBe(true);
    expect(overlay.store.speechPreferences.values.dictationFirstSpeaker).toBe(false);
    expect(overlay.store.awaitingMuteState).toBe(true);
    expect(screen.getByText(/Dictation mute state is unavailable/)).toBeDefined();
    expect(overlay.open).not.toHaveBeenCalled();
    await overlay.emit(false);
    await waitFor(() => expect(overlay.open).toHaveBeenCalledOnce());
    expect(overlay.store.awaitingMuteState).toBe(false);
    await overlay.emit(true);
    expect(overlay.stop).toHaveBeenCalledOnce();
  });

  it.each([
    { enabled: false, muted: false },
    { enabled: false, muted: true },
    { enabled: true, muted: false },
    { enabled: true, muted: true },
  ])(
    "preserves enabled=$enabled muted=$muted through the originating capture command and wire contract",
    async ({ enabled, muted }) => {
      let snapshot = captureSnapshot(muted);
      using origin = createRendererStoreFixture({
        client: {
          electron: {
            startScreenCapture: async (preferences) => {
              const routing = Schema.decodeUnknownSync(Schema.toCodecJson(CapturePreferences))(
                Schema.encodeSync(Schema.toCodecJson(CapturePreferences))(preferences),
              );
              snapshot = { ...snapshot, routing };
              return { annotationColor: preferences.annotationColor };
            },
          },
        },
      });
      origin.root.dictationStore.enabled = enabled;
      origin.root.dictationStore.muted = muted;
      await origin.root.screenCaptureStore.capture();
      expect(snapshot.routing.dictation).toMatchObject({ enabled, muted });
      await using overlay = captureDictation(snapshot);
      await overlay.initialize();
      await overlay.annotate();
      expect(overlay.store.dictationStore.enabled).toBe(enabled);
      expect(overlay.store.dictationStore.muted).toBe(muted);
      expect(overlay.store.awaitingMuteState).toBe(false);
      if (enabled && !muted) await waitFor(() => expect(overlay.open).toHaveBeenCalledOnce());
      else expect(overlay.open).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "uses the originating window's first-speaker setting (%s) for annotation dictation",
    async (firstSpeaker) => {
      let snapshot = captureSnapshot(false);
      using origin = createRendererStoreFixture({
        client: {
          electron: {
            startScreenCapture: async (preferences) => {
              snapshot = {
                ...snapshot,
                routing: Schema.decodeUnknownSync(CapturePreferences)(preferences),
              };
              return { annotationColor: preferences.annotationColor };
            },
          },
        },
      });
      origin.root.dictationStore.enabled = true;
      origin.root.speechInputSettingsStore.setDictationFirstSpeaker(firstSpeaker);
      await origin.root.screenCaptureStore.capture();
      await using overlay = captureDictation(snapshot);
      await overlay.initialize();
      await overlay.annotate();
      await act(async () => overlay.open.mock.lastCall?.[0](new Float32Array(12_800).fill(0.1)));
      expect(overlay.transcribe).toHaveBeenCalledOnce();
      const audio = overlay.transcribe.mock.lastCall?.[0];
      if (firstSpeaker) expect(audio?.speakerRoundId).toBeTruthy();
      else expect(audio).not.toHaveProperty("speakerRoundId");
    },
  );

  it.each([true, false])(
    "uses shared mute=%s when legacy routing has no mute key",
    async (muted) => {
      const snapshot = captureSnapshot(false);
      const { muted: _omitted, ...voice } = snapshot.routing.dictation;
      await using fixture = captureDictation({
        ...snapshot,
        routing: { ...snapshot.routing, dictation: voice },
      });
      await fixture.emit(muted);
      await fixture.initialize();
      await fixture.annotate();
      expect(fixture.store.dictationStore.muted).toBe(muted);
      expect(fixture.store.awaitingMuteState).toBe(false);
      if (muted) expect(fixture.open).not.toHaveBeenCalled();
      else await waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    },
  );

  it("keeps disabled legacy dictation off and allows explicit unmute of enabled unknown state", async () => {
    const snapshot = captureSnapshot(false);
    const { muted: _omitted, ...voice } = snapshot.routing.dictation;
    await using fixture = captureDictation({
      ...snapshot,
      routing: { ...snapshot.routing, dictation: { ...voice, enabled: false } },
    });
    await fixture.initialize();
    await fixture.annotate();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.store.dictationStore.enabled).toBe(false);
    expect(fixture.store.awaitingMuteState).toBe(false);
    await act(async () => {
      fixture.store.dictationStore.enabled = true;
    });
    expect(fixture.open).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Unmute dictation" })),
    );
    await waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
  });

  it("does not accept a malformed mute value as a legacy omission", () => {
    expect(() =>
      Schema.decodeUnknownSync(SnapshotSchema)({
        ...captureSnapshot(true),
        routing: { ...captureRouting, dictation: { ...captureRouting.dictation, muted: "false" } },
      }),
    ).toThrow();
  });

  it("shows initialization failure with retry and cancel, and recovers without opening audio", async () => {
    let attempts = 0;
    await using fixture = captureDictation(async () => {
      if (++attempts === 1)
        throw new Error('Missing key at ["value"]["routing"]["dictation"]["muted"]');
      return captureSnapshot(true);
    });
    await fixture.initialize();
    expect(screen.getByRole("alert").textContent).toContain("Screen capture could not initialize");
    expect(screen.getByRole("alert").textContent).toContain("restart Cake");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(attempts).toBe(2);
    expect(fixture.store.snapshot).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fixture.open).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledOnce();
  });

  it("allows Escape cleanup after decode failure, without requiring a snapshot", async () => {
    await using fixture = captureDictation(async () => {
      throw new Error("Invalid capture response");
    });
    await fixture.initialize();
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(undefined, "yellow", {
      signal: fixture.store.signal,
    });
    expect(fixture.store.cancelled).toBe(true);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("does not initialize a late snapshot after Escape while loading", async () => {
    let resolve!: (snapshot: ScreenCaptureSnapshot) => void;
    const pending = new Promise<ScreenCaptureSnapshot>((complete) => {
      resolve = complete;
    });
    await using fixture = captureDictation(pending);
    const loading = fixture.store.initialize();
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    resolve(captureSnapshot(false));
    await act(async () => loading);
    expect(fixture.store.snapshot).toBeUndefined();
    expect(fixture.store.dictationStore.enabled).toBe(false);
    expect(fixture.open).not.toHaveBeenCalled();
  });
  it("inherits mute before the first observation, then follows live shared unmute and mute", async () => {
    await using fixture = captureDictation(captureSnapshot(true));
    await fixture.initialize();
    expect(fixture.store.dictationStore.muted).toBe(true);
    await fixture.annotate();
    expect(screen.getByRole("button", { name: "Unmute dictation" })).toBeDefined();
    expect(fixture.open).not.toHaveBeenCalled();
    await fixture.emit(true);
    expect(fixture.open).not.toHaveBeenCalled();
    await fixture.emit(false);
    await waitFor(() => expect(fixture.store.dictationStore.phase).toBe("listening"));
    expect(fixture.open).toHaveBeenCalledOnce();
    await fixture.emit(true);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.store.dictationStore.phase).toBe("paused");
    await fixture.annotate();
    expect(fixture.open).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "keeps live mute=%s when older routing finishes loading",
    async (muted) => {
      await using fixture = captureDictation(captureSnapshot(!muted));
      await fixture.emit(muted);
      await fixture.initialize();
      expect(fixture.store.dictationStore.muted).toBe(muted);
      await fixture.annotate();
      if (muted) expect(fixture.open).not.toHaveBeenCalled();
      else await waitFor(() => expect(fixture.store.dictationStore.phase).toBe("listening"));
    },
  );

  it("preserves unmuted annotation dictation and closes audio and observation with the overlay", async () => {
    await using fixture = captureDictation(captureSnapshot(false));
    await fixture.initialize();
    await fixture.annotate();
    await waitFor(() => expect(fixture.store.dictationStore.phase).toBe("listening"));
    expect(fixture.open).toHaveBeenCalledOnce();
    await fixture.close();
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.store.signal.aborted).toBe(true);
  });

  it("does not initialize dictation from a late snapshot after the overlay closes", async () => {
    let resolve!: (snapshot: ScreenCaptureSnapshot) => void;
    const pending = new Promise<ScreenCaptureSnapshot>((complete) => {
      resolve = complete;
    });
    await using fixture = captureDictation(pending);
    const dictation = fixture.store.dictationStore;
    const initialization = fixture.store.initialize();
    await fixture.close();
    resolve(captureSnapshot(false));
    await initialization;
    expect(fixture.store.snapshot).toBeUndefined();
    expect(dictation.enabled).toBe(false);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("takes routing mute from the originating window, not an unrelated window's local state", () => {
    using origin = createRendererStoreFixture();
    using other = createRendererStoreFixture();
    origin.root.dictationStore.muted = true;
    other.root.dictationStore.muted = false;
    expect(origin.root.screenCaptureStore.destinations.dictation.muted).toBe(true);
    expect(other.root.screenCaptureStore.destinations.dictation.muted).toBe(false);
    other.root.dictationStore.enabled = true;
    expect(origin.root.screenCaptureStore.destinations.dictation.muted).toBe(true);
    expect(origin.root.screenCaptureStore.destinations.dictation.enabled).toBe(false);
  });
});
