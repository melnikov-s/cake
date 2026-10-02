/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { DictationAudio } from "../../../src/domain/dictation/dictation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SettingsDictationSection } from "../../../src/renderer/components/settings-dictation-section";
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
  } = {},
) {
  const audio = browserAudio(options);
  const requests: Array<{ audio: DictationAudio; reply: ReturnType<typeof deferred<string>> }> = [];
  const prepare = vi.fn<Client["dictation"]["prepare"]>(async () => {
    await options.modelReady;
    // The native authority publishes Ready when its warmup completes.
    fixture.root.dictationStore.applyState({ ...installedDictationState, status: "ready" });
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
    client: { dictation: { prepare, release, transcribe }, sessionChats: { prompt } },
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  fixture.root.dictationStore.applyState({
    ...installedDictationState,
    status: options.modelReady ? "loading" : "ready",
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
    expect(fixture.prepare).toHaveBeenCalledOnce();
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

  it("discards pending speech on dismissal and resumes the field only after refocus", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.user.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(mode().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Dictation paused")).toBeDefined();
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    await fixture.recognize(0, "Discard after dismissal");
    expect(trial().value).toBe("");
    await fixture.user.keyboard(" kept");
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    await fixture.user.click(trial());
    listening();
    expect(fixture.audio.getUserMedia).toHaveBeenCalledTimes(2);
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(1, "Resumed");
    expect(trial().value).toBe(" kept Resumed");
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
