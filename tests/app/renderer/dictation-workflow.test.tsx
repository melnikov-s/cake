/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { DictationAudio, DictationState } from "../../../src/domain/dictation/dictation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SettingsDictationSection } from "../../../src/renderer/components/settings-dictation-section";
import { WindowStatePersistence } from "../../../src/renderer/persistence/WindowStatePersistence";
import type { TestClientOverrides } from "./test-client";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { installedDictationState } from "../../helpers/dictation";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Browser audio boundary only: the real microphone adapter and dictation hook stay in use. */
function browserAudio(options: { permission?: Promise<void>; microphoneReady?: Promise<void> }) {
  class Track extends EventTarget {
    stop = vi.fn();
  }
  const tracks: Track[] = [];
  const processors: Worklet[] = [];
  type Stream = { getTracks(): Track[]; getAudioTracks(): Track[] };
  const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<Stream>>(async () => {
    const track = new Track();
    tracks.push(track);
    await options.permission;
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  });
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "usb-mic", label: "USB microphone" },
      ],
    },
  });
  class Node {
    connect<T>(node: T): T {
      return node;
    }
    disconnect() {}
  }
  class Context {
    audioWorklet = { addModule: async () => undefined };
    destination = new Node();
    createMediaStreamSource() {
      return new Node();
    }
    createGain() {
      return Object.assign(new Node(), { gain: { value: 1 } });
    }
    async resume() {
      await options.microphoneReady;
    }
    async close() {}
  }
  interface WorkletPort {
    onmessage: ((event: MessageEvent<Float32Array | "flushed">) => void) | null;
    postMessage(message: "flush"): void;
  }
  class Worklet extends Node {
    port: WorkletPort = {
      onmessage: null,
      postMessage: (message) => {
        if (message === "flush") this.emit("flushed");
      },
    };
    constructor() {
      super();
      processors.push(this);
    }
    emit(data: Float32Array | "flushed") {
      this.port.onmessage?.(new MessageEvent("message", { data }));
    }
  }
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return {
    tracks,
    processors,
    getUserMedia,
    async push(samples: Float32Array, capture = processors.length - 1) {
      await act(async () => processors[capture]!.emit(samples));
    },
    [Symbol.dispose]() {
      if (descriptor) Object.defineProperty(navigator, "mediaDevices", descriptor);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      vi.unstubAllGlobals();
    },
  };
}

function renderDictation(
  options: {
    modelReady?: Promise<void>;
    permission?: Promise<void>;
    microphoneReady?: Promise<void>;
    snapshot?: StoreSnapshot;
    state?: DictationState;
    client?: TestClientOverrides;
  } = {},
) {
  const audio = browserAudio(options);
  const requests: Array<{ audio: DictationAudio; reply: ReturnType<typeof deferred<string>> }> = [];
  const prepare = vi.fn<Client["dictation"]["prepare"]>(async () => {
    await options.modelReady;
    // The native authority publishes Ready when its warmup completes.
    fixture.root.dictationStore.applyState({
      ...installedDictationState,
      ...options.state,
      status: "ready",
    });
  });
  const release = vi.fn<Client["dictation"]["release"]>(async () => undefined);
  const transcribe = vi.fn<Client["dictation"]["transcribe"]>((input) => {
    const reply = deferred<string>();
    requests.push({ audio: input, reply });
    return reply.promise;
  });
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000001"),
  );
  const sessionId = "dictation-session";
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId, projectPath: "/project" })],
    snapshot: options.snapshot,
    client: {
      ...options.client,
      dictation: { prepare, release, transcribe, ...options.client?.dictation },
      sessionChats: { prompt },
    },
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  fixture.root.dictationStore.applyState({
    ...installedDictationState,
    status: options.modelReady ? "loading" : "ready",
    ...options.state,
  });
  applyConversationUpdate(fixture.models.projectConversation(sessionId, "/project"), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId,
      sessionFile: "/project/dictation-session.jsonl",
      parts: [],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  });
  const view = render(
    <StoreProvider store={fixture.root.dictationStore}>
      <SettingsDictationSection store={fixture.root.settingsStore.dictation} />
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    root: fixture.root,
    client: fixture.client,
    audio,
    prepare,
    release,
    requests,
    prompt,
    async recognize(index: number, text: string) {
      await act(async () => {
        requests[index]!.reply.resolve(text);
        await requests[index]!.reply.promise;
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
      audio[Symbol.dispose]();
    },
  };
}

const trial = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Try dictation" });
const message = () => screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
const mode = () => screen.getByRole("switch", { name: "Dictation mode" });
const listening = () => expect(screen.getAllByText("Listening").length).toBeGreaterThan(0);
afterEach(cleanup);

describe("Dictation writing-field workflow", () => {
  it("persists only user enablement and microphone choice, restoring capture on focus", async () => {
    let saved: StoreSnapshot | undefined;
    {
      const save = vi.fn<Client["windowState"]["save"]>(async () => undefined);
      using fixture = renderDictation({ client: { windowState: { save } } });
      using persistence = new WindowStatePersistence(fixture.client, (error) => {
        throw error;
      });
      persistence.observe(fixture.root);
      await fixture.user.click(mode());
      await fixture.user.selectOptions(screen.getByLabelText("Microphone"), "usb-mic");
      await fixture.user.click(trial());
      listening();
      await fixture.user.keyboard("{Escape}");
      expect(mode().getAttribute("aria-checked")).toBe("true");
      await persistence.flush();
      saved = toSnapshot(fixture.root);
      expect(save).toHaveBeenLastCalledWith(saved);
      expect(saved.children.dictationStore).toEqual({
        state: { enabled: true, deviceId: "usb-mic" },
        children: {},
      });
    }
    {
      using fixture = renderDictation({ snapshot: saved });
      expect(mode().getAttribute("aria-checked")).toBe("true");
      await waitFor(() =>
        expect(screen.getByLabelText<HTMLSelectElement>("Microphone").value).toBe("usb-mic"),
      );
      expect(fixture.audio.getUserMedia).not.toHaveBeenCalled();
      await fixture.user.click(trial());
      listening();
      expect(fixture.audio.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: expect.objectContaining({ deviceId: { exact: "usb-mic" } }),
        }),
      );
      await fixture.user.click(mode());
      expect(mode().getAttribute("aria-checked")).toBe("false");
      saved = toSnapshot(fixture.root);
    }
    {
      using fixture = renderDictation({ snapshot: saved });
      expect(mode().getAttribute("aria-checked")).toBe("false");
      await fixture.user.click(trial());
      expect(fixture.audio.getUserMedia).not.toHaveBeenCalled();
    }
  });

  it.each([
    { operation: "folder", fail: false },
    { operation: "folder", fail: true },
    { operation: "install", fail: false },
    { operation: "install", fail: true },
    { operation: "remove", fail: false },
    { operation: "remove", fail: true },
  ])(
    "pauses for model $operation (failure: $fail) without changing the user preference",
    async ({ operation, fail }) => {
      const pending = deferred<void>();
      const mutation = vi.fn(async () => pending.promise);
      using fixture = renderDictation({
        state: { ...installedDictationState, status: "ready", modelPath: "/external/model" },
        client: { dictation: { setModelPath: mutation, install: mutation, remove: mutation } },
      });
      await fixture.user.click(mode());
      await fixture.user.click(trial());
      listening();
      const captures = fixture.audio.getUserMedia.mock.calls.length;
      if (operation === "folder") {
        await fixture.user.type(
          screen.getByLabelText("Use an existing Core ML Parakeet model folder"),
          "/other/model",
        );
        await fixture.user.click(screen.getByRole("button", { name: "Use model folder" }));
      } else {
        await fixture.user.click(
          screen.getByRole("button", {
            name: operation === "install" ? "Download Parakeet model" : "Remove Cake model data",
          }),
        );
      }
      expect(mutation).toHaveBeenCalledOnce();
      expect(mode().getAttribute("aria-checked")).toBe("true");
      await fixture.user.click(trial());
      expect(fixture.audio.getUserMedia).toHaveBeenCalledTimes(captures);
      await act(async () => {
        if (fail) pending.reject(new Error("Model maintenance failed"));
        else {
          pending.resolve();
          if (operation === "remove")
            fixture.root.dictationStore.applyState({
              ...installedDictationState,
              status: "missing",
              modelPath: undefined,
            });
        }
      });
      expect(mode().getAttribute("aria-checked")).toBe("true");
      if (fail) expect(screen.getAllByText("Model maintenance failed").length).toBeGreaterThan(0);
      await fixture.user.click(mode());
      expect(mode().getAttribute("aria-checked")).toBe("false");
    },
  );

  it("shows in-field bars from microphone volume, decays on silence and resets on refocus", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    const field = trial().closest('[data-slot="dictation-field"]')!;
    const meter = () => field.querySelector('[data-slot="voice-meter"]');
    const scales = () =>
      Array.from(field.querySelectorAll<HTMLElement>('[data-slot="voice-meter-bar"]'), (bar) =>
        Number(bar.style.getPropertyValue("--voice-bar-scale")),
      );
    expect(meter()).not.toBeNull();
    expect(scales()).toHaveLength(7);
    expect(scales().every((scale) => scale === 0.18)).toBe(true);
    await fixture.audio.push(new Float32Array(128));
    expect(scales().every((scale) => scale === 0.18)).toBe(true);
    await fixture.audio.push(new Float32Array(800).fill(0.1));
    const speaking = scales();
    expect(speaking.every((scale) => scale > 0.18 && scale <= 1)).toBe(true);
    await fixture.audio.push(new Float32Array(800));
    expect(scales().every((scale, index) => scale < speaking[index]!)).toBe(true);
    await fixture.user.click(message());
    expect(meter()).toBeNull();
    const otherBars = message()
      .closest('[data-slot="dictation-field"]')!
      .querySelectorAll<HTMLElement>('[data-slot="voice-meter-bar"]');
    expect(
      Array.from(otherBars).every(
        (bar) => Number(bar.style.getPropertyValue("--voice-bar-scale")) === 0.18,
      ),
    ).toBe(true);
    // Late PCM from the abandoned microphone must not animate the new field.
    await fixture.audio.push(new Float32Array(800).fill(1), 0);
    expect(
      Array.from(otherBars).every(
        (bar) => Number(bar.style.getPropertyValue("--voice-bar-scale")) === 0.18,
      ),
    ).toBe(true);
    await fixture.user.click(trial());
    expect(scales().every((scale) => scale === 0.18)).toBe(true);
    await fixture.audio.push(new Float32Array(800).fill(Number.NaN));
    expect(scales().every((scale) => scale === 0.18)).toBe(true);
    await fixture.user.keyboard("{Escape}");
    expect(meter()).toBeNull();
  });

  it("waits for both model and microphone readiness, capturing only the latest focused field", async () => {
    const model = deferred<void>();
    const microphone = deferred<void>();
    using fixture = renderDictation({
      modelReady: model.promise,
      microphoneReady: microphone.promise,
    });
    await fixture.user.click(trial());
    expect(fixture.audio.getUserMedia).not.toHaveBeenCalled();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    await fixture.user.click(message());
    expect(screen.getAllByText("Preparing dictation… Wait to speak").length).toBeGreaterThan(0);
    expect(fixture.audio.getUserMedia).not.toHaveBeenCalled();
    await act(async () => model.resolve());
    // Preparation is idempotent; each focus generation may re-prepare after a voice handoff.
    expect(fixture.prepare).toHaveBeenCalled();
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    expect(screen.queryByText("Listening")).toBeNull();
    await act(async () => microphone.resolve());
    listening();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Latest field receives speech");
    expect(message().value).toBe("Latest field receives speech");
    expect(trial().value).toBe("");
  });

  it("inserts progressive speech with bounded PCM and discards unfinished speech on field changes", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    listening();
    const samples = new Float32Array(12_800);
    samples.set([1.5, -1.5, Number.POSITIVE_INFINITY, Number.NaN, 0.25]);
    await fixture.audio.push(samples);
    const bytes = Uint8Array.from(atob(fixture.requests[0]!.audio.pcm), (character) =>
      character.charCodeAt(0),
    );
    const pcm = new DataView(bytes.buffer);
    expect([0, 1, 2, 3, 4].map((index) => pcm.getFloat32(index * 4, true))).toEqual([
      1, -1, 0, 0, 0.25,
    ]);
    await fixture.recognize(0, "Keep this");
    expect(message().value).toBe("Keep this");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(1, "Keep this sentence");
    expect(message().value).toBe("Keep this sentence");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.user.click(trial());
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    await fixture.recognize(2, "Old unfinished tail");
    expect(message().value).toBe("Keep this sentence");
    expect(trial().value).toBe("");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(3, "New field");
    expect(trial().value).toBe("New field");
    expect(fixture.requests[3]!.audio.utteranceId).not.toBe(fixture.requests[0]!.audio.utteranceId);
  });

  it("preserves manual edits and invalidates recognition without reacquiring the microphone", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Visible speech");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.user.type(trial(), " edited");
    await fixture.recognize(1, "Must not overwrite typing");
    expect(trial().value).toBe("Visible speech edited");
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    expect(fixture.audio.tracks[0]!.stop).not.toHaveBeenCalled();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(2, "Speech after typing");
    expect(trial().value).toBe("Visible speech edited Speech after typing");
    expect(fixture.requests[2]!.audio.utteranceId).not.toBe(fixture.requests[1]!.audio.utteranceId);
  });

  it("mutes pending speech, preserves typing across field changes, and unmutes from the same control", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Keep this");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.user.click(screen.getByRole("button", { name: "Mute dictation" }));
    expect(mode().getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Unmute dictation" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.release).not.toHaveBeenCalled();
    await fixture.recognize(1, "Discard after mute");
    expect(trial().value).toBe("Keep this");
    await fixture.user.keyboard(" kept");
    await fixture.user.click(message());
    expect(screen.getByRole("button", { name: "Unmute dictation" })).toBeDefined();
    await fixture.user.click(trial());
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    await fixture.user.click(screen.getByRole("button", { name: "Unmute dictation" }));
    listening();
    expect(
      screen.getByRole("button", { name: "Mute dictation" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(fixture.audio.getUserMedia).toHaveBeenCalledTimes(2);
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(2, "Resumed");
    expect(trial().value).toBe("Keep this kept Resumed");
  });

  it("muting during microphone preparation stops a late capture and permits a fresh unmute", async () => {
    const permission = deferred<void>();
    using fixture = renderDictation({ permission: permission.promise });
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    await waitFor(() => expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce());
    await fixture.user.click(screen.getByRole("button", { name: "Mute dictation" }));
    await act(async () => permission.resolve());
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Unmute dictation" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Unmute dictation" }));
    listening();
    expect(fixture.audio.getUserMedia).toHaveBeenCalledTimes(2);
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Fresh speech");
    expect(trial().value).toBe("Fresh speech");
  });

  it("drains pending and final audio before Enter submits exactly one complete message", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.audio.push(new Float32Array(3200));
    await fixture.user.keyboard("{Enter}{Enter}");
    expect(screen.getAllByText("Finishing…").length).toBeGreaterThan(0);
    expect(fixture.prompt).not.toHaveBeenCalled();
    await fixture.recognize(0, "Beginning");
    await waitFor(() => expect(fixture.requests).toHaveLength(2));
    expect(message().value).toBe("Beginning");
    expect(fixture.requests[1]!.audio).toMatchObject({
      final: true,
      utteranceId: fixture.requests[0]!.audio.utteranceId,
    });
    expect(atob(fixture.requests[1]!.audio.pcm)).toHaveLength(3200 * 4);
    expect(fixture.prompt).not.toHaveBeenCalled();
    await fixture.recognize(1, "Beginning and last words");
    await waitFor(() =>
      expect(fixture.prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: "dictation-session",
          text: "Beginning and last words",
        }),
        expect.any(Object),
      ),
    );
    expect(message().value).toBe("");
    listening();
  });

  it("cancels a finishing submission when focus changes without modifying either draft", async () => {
    using fixture = renderDictation();
    await fixture.user.type(message(), "Keep draft");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.user.keyboard("{Enter}");
    await waitFor(() => expect(fixture.requests).toHaveLength(1));
    await fixture.user.click(trial());
    await fixture.recognize(0, "Do not send");
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(message().value).toBe("Keep draft");
    expect(trial().value).toBe("");
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    listening();
  });

  it("stops a microphone permission result that arrives after the field loses focus", async () => {
    const permission = deferred<void>();
    using fixture = renderDictation({ permission: permission.promise });
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    await act(async () => permission.resolve());
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.audio.processors).toHaveLength(0);
    expect(screen.getByText("Dictation paused")).toBeDefined();
    await fixture.user.click(trial());
    listening();
    expect(fixture.audio.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("shows recognition failure, stops capture, and never submits a truncated draft", async () => {
    using fixture = renderDictation();
    await fixture.user.type(message(), "Keep draft");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.user.keyboard("{Enter}");
    await waitFor(() => expect(fixture.requests).toHaveLength(1));
    await act(async () => {
      fixture.requests[0]!.reply.reject(new Error("Engine stopped"));
      await fixture.requests[0]!.reply.promise.catch(() => undefined);
    });
    expect(screen.getAllByText("Engine stopped").length).toBeGreaterThan(0);
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(message().value).toBe("Keep draft");
    await fixture.user.click(mode());
    expect(fixture.release).toHaveBeenCalledOnce();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    listening();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(1, "Recovered speech");
    expect(message().value).toBe("Keep draft Recovered speech");
  });
});
