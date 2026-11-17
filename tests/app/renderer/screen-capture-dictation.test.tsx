/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Effect, Queue, Stream } from "effect";
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
function captureDictation(snapshot: ScreenCaptureSnapshot | Promise<ScreenCaptureSnapshot>) {
  const stop = vi.fn();
  const open = vi.fn<Microphone["open"]>(async () => ({
    stop,
    finish: async () => {},
    discardPending: async () => {},
  }));
  const client = createTestClient({
    dictation: {
      prepare: async () => {},
      claim: async () => ({ claim: 1 }),
      trace: async () => {},
    },
  });
  const store = mount(
    createStore(ScreenCaptureOverlayStore, {
      client: {
        screenCaptureState: async () => snapshot,
        finishScreenCapture: async () => {},
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
    open,
    stop,
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
