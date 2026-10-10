/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { installedDictationState } from "../../helpers/dictation";
import { detectFixtureSpeech } from "../../helpers/speech-detection";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createLiveMessageProjector } from "../../../src/services/pi/runtime/session-projection";
import { projectConversationDisplay } from "../../../src/services/pi/runtime/conversation-display-projection";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import type { Microphone } from "../../../src/renderer/dictation/microphone";
import type { SpeechPlayback } from "../../../src/renderer/speech/playback";
import { Chat } from "../../../src/renderer/components/chat";
import { SettingsSpeechSection } from "../../../src/renderer/components/settings-speech-section";
import { speechOutputSettings, pocketTtsState } from "../../helpers/speech-output";
import { SettingsDictationSection } from "../../../src/renderer/components/settings-dictation-section";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
const assistant = (
  text: string,
  status: "streaming" | "complete" = "streaming",
  id = "answer",
): Extract<UiPart, { kind: "text" }> => ({
  id,
  renderKey: id === "history" ? "history" : "reply-1",
  kind: "text",
  role: "assistant",
  text,
  status,
});
const consumed = (id = "input"): Extract<UiPart, { kind: "text" }> => ({
  id,
  entryId: id,
  kind: "text",
  role: "user",
  text: "New request",
  status: "complete",
});
function fixture(
  options: {
    prepare?: Client["dictation"]["prepare"];
    transcribe?: Client["dictation"]["transcribe"];
    postProcess?: Client["workspaces"]["postProcessDictation"];
    punctuate?: Client["dictation"]["punctuate"];
    detectSpeech?: Client["dictation"]["detectSpeech"];
    synthesize?: Client["speechOutput"]["synthesize"];
    enqueue?: SpeechPlayback["enqueue"];
    drain?: SpeechPlayback["drain"];
    microphoneError?: Error;
    streaming?: boolean;
    snapshot?: StoreSnapshot;
  } = {},
) {
  let onAudio: ((samples: Float32Array) => void) | undefined;
  const stopCapture = vi.fn();
  const microphone: Microphone = {
    open: vi.fn(async (callback) => {
      if (options.microphoneError) throw options.microphoneError;
      onAudio = callback;
      return { stop: stopCapture, finish: async () => {} };
    }),
    devices: async () => [],
  };
  const playback: SpeechPlayback = {
    start: vi.fn(async () => {}),
    enqueue: vi.fn(options.enqueue ?? (async () => {})),
    drain: vi.fn(options.drain ?? (async () => {})),
    stop: vi.fn(),
  };
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000001"),
  );
  const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => {});
  const transcribe = vi.fn<Client["dictation"]["transcribe"]>(
    options.transcribe ?? (async () => "Recognized speech"),
  );
  const synthesize = vi.fn<Client["speechOutput"]["synthesize"]>(
    options.synthesize ??
      (async (_request, consume) =>
        consume({ encoding: "pcm_s16le", sampleRate: 24000, pcm: "AAA=" })),
  );
  const release = vi.fn(async () => {});
  const setApiKey = vi.fn(async () => {}),
    setVoice = vi.fn(async () => {});
  const setSpeed = vi.fn<Client["speechOutput"]["setSpeed"]>(async (speed) => {
    const settings = root.speechSettingsStore.settings;
    if (settings) root.speechSettingsStore.applySettings({ ...settings, speed });
  });
  const rootFixture = createRendererStoreFixture({
    snapshot: options.snapshot,
    microphone,
    speechPlayback: playback,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "one", projectPath: "/project" })],
    client: {
      dictation: {
        prepare: options.prepare ?? (async () => {}),
        release,
        transcribe,
        detectSpeech: options.detectSpeech ?? detectFixtureSpeech,
        ...(options.punctuate ? { punctuate: options.punctuate } : {}),
      },
      speechOutput: {
        synthesize,
        setApiKey,
        setVoice,
        setSpeed,
        listVoices: async () => [{ id: "voice", name: "Fixture voice" }],
      },
      sessionChats: { prompt, abort },
      workspaces: { postProcessDictation: options.postProcess ?? (async (text) => text) },
    },
  });
  const { root } = rootFixture;
  root.speechSettingsStore.applySettings({
    ...speechOutputSettings(),
    keyConfigured: true,
    voiceId: "voice",
    modelId: "eleven_flash_v2_5",
    speed: 1,
    voices: [{ id: "voice", name: "Fixture voice" }],
  });
  const session = root.sessionRegistry.load("one", "/project");
  root.appShellStore.selectProjectSession("one");
  root.projectWorkbenchStore.showLoadedSession("one");
  let revision = 0;
  let parts: UiPart[] = [assistant("Historical answer", "complete", "history")];
  function publish(next: UiPart[]) {
    parts = next;
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot: {
        sessionId: "one",
        sessionFile: "/project/session.jsonl",
        parts,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: options.streaming ?? false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
  }
  publish(parts);
  const view = render(
    <StoreProvider store={root.dictationStore}>
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
      <ToastHost store={root.toastStore} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  return {
    root,
    session,
    playback,
    microphone,
    stopCapture,
    prompt,
    abort,
    transcribe,
    synthesize,
    release,
    setApiKey,
    setVoice,
    setSpeed,
    user,
    async enter() {
      await user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
      await waitFor(() => expect(root.conversationModeStore.phase).toBe("active"));
    },
    async frames(value: number, count: number) {
      await act(async () => {
        for (let i = 0; i < count; i++) onAudio?.(new Float32Array(1600).fill(value));
      });
    },
    async detectorFrames(value: number, count: number) {
      await act(async () => {
        for (let i = 0; i < count; i++) onAudio?.(new Float32Array(4096).fill(value));
      });
    },
    async say() {
      await this.frames(0.1, 4);
      await this.frames(0, 33);
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    },
    publish(next: UiPart[]) {
      act(() => publish(next));
    },
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Project Session conversation mode", () => {
  it("uses shared local processing before auto-send without invoking utility cleanup", async () => {
    const result = deferred<{ text: string; pendingStart: number }>();
    const punctuate = vi.fn<Client["dictation"]["punctuate"]>((input) =>
      input.final
        ? result.promise
        : Promise.resolve({ text: "Is this a question that I should be asking", pendingStart: 24 }),
    );
    const postProcess = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      async () => "Unexpected utility work",
    );
    using f = fixture({
      transcribe: async () => "Is this a question that I should? Be asking?",
      punctuate,
      postProcess,
      snapshot: {
        state: {},
        children: { dictationStore: { state: { textProcessingMode: "local" }, children: {} } },
      },
    });
    await f.enter();
    await f.frames(0.1, 4);
    await f.frames(0, 33);
    await waitFor(() =>
      expect(punctuate).toHaveBeenLastCalledWith(
        {
          utteranceId: expect.any(String),
          text: "Is this a question that I should? Be asking?",
          final: true,
        },
        expect.any(Object),
      ),
    );
    expect(f.prompt).not.toHaveBeenCalled();
    await act(async () =>
      result.resolve({ text: "Is this a question that I should be asking?", pendingStart: 43 }),
    );
    await waitFor(() =>
      expect(f.prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Is this a question that I should be asking?" }),
        expect.any(Object),
      ),
    );
    expect(postProcess).not.toHaveBeenCalled();
  });
  it("waits for light cleanup before automatically sending voice input", async () => {
    const result = deferred<string>();
    const postProcess = vi.fn<Client["workspaces"]["postProcessDictation"]>(() => result.promise);
    using f = fixture({ transcribe: async () => "Um, hello. There.", postProcess });
    await f.enter();
    await f.frames(0.1, 4);
    await f.frames(0, 33);
    await waitFor(() => expect(postProcess).toHaveBeenCalledOnce());
    expect(f.prompt).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="provisional-text"]')?.textContent).toBe(
      "Um, hello. There.",
    );
    await act(async () => result.resolve("Hello there."));
    expect(document.querySelector('[data-slot="provisional-text"]')).toBeNull();
    await waitFor(() =>
      expect(f.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Hello there." }),
        expect.any(Object),
      ),
    );
  });

  it("retains manual edits made while voice cleanup is pending", async () => {
    const result = deferred<string>();
    const postProcess = vi.fn<Client["workspaces"]["postProcessDictation"]>(() => result.promise);
    using f = fixture({ postProcess });
    await f.enter();
    await f.frames(0.1, 4);
    await f.frames(0, 33);
    await waitFor(() => expect(postProcess).toHaveBeenCalledOnce());
    await f.user.type(screen.getByRole("combobox", { name: "Message" }), " edited");
    expect(document.querySelector('[data-slot="provisional-text"]')).toBeNull();
    await act(async () => result.resolve("Clean speech"));
    expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(
      "Recognized speech edited",
    );
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("does not send an utterance that was completely retracted", async () => {
    using f = fixture({ postProcess: async () => "" });
    await f.enter();
    await f.frames(0.1, 4);
    await f.frames(0, 33);
    await waitFor(() =>
      expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe(""),
    );
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("enter offers a highlighted listening ear, toggles input mute and exits on the existing Chat", async () => {
    using f = fixture();
    await f.enter();
    const ear = screen.getByRole("button", { name: "Mute input", pressed: true });
    expect(ear.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const listeningIcon = ear.querySelector("svg")?.innerHTML;
    await f.user.click(ear);
    const mutedEar = screen.getByRole("button", { name: "Unmute input", pressed: false });
    expect(mutedEar.querySelector("svg")?.innerHTML).not.toBe(listeningIcon);
    expect(f.root.conversationModeStore.muted).toBe(true);
    await f.user.click(mutedEar);
    expect(screen.getByRole("button", { name: "Mute input", pressed: true })).toBeDefined();
    expect(f.root.conversationModeStore.muted).toBe(false);
    await f.user.click(screen.getByRole("button", { name: "Exit conversation mode" }));
    expect(screen.getByRole("button", { name: "Enter conversation mode" })).toBeDefined();
  });
  it("missing model, key, voice or microphone permission shows an actionable error and leaves text chat usable", async () => {
    for (const kind of ["model", "key", "voice", "permission"] as const) {
      using f = fixture({
        prepare:
          kind === "model"
            ? async () => {
                throw new Error("Install Parakeet in Voice input settings");
              }
            : undefined,
        microphoneError:
          kind === "permission" ? new Error("Microphone permission denied") : undefined,
      });
      if (kind === "key" || kind === "voice")
        f.root.speechSettingsStore.applySettings({
          ...speechOutputSettings(),
          keyConfigured: kind !== "key",
          modelId: "eleven_flash_v2_5",
          speed: 1,
          voices: [],
        });
      await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
      const toast = await screen.findByRole("alert");
      expect(toast.textContent).toContain("Conversation mode unavailable");
      expect(screen.getByRole("button", { name: "Open Voice & Dictation settings" })).toBeDefined();
      await f.user.type(screen.getByRole("combobox", { name: "Message" }), "Text works");
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(f.prompt).not.toHaveBeenCalled();
    }
  });
  it("clicking a speech-error toast opens Speech output settings and dismisses the notification", async () => {
    using f = fixture();
    act(() =>
      f.root.speechSettingsStore.applySettings({
        ...speechOutputSettings(),
        keyConfigured: false,
        modelId: "eleven_flash_v2_5",
        speed: 1,
        voices: [],
      }),
    );
    await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
    const message = await screen.findByText(
      "Configure an ElevenLabs key and voice in Settings → Voice & Dictation.",
    );
    await f.user.click(message);
    expect(f.root.appShellStore.surface).toBe("settings");
    expect(f.root.settingsStore.activePage).toBe("voice");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("speech-error toasts expire without requiring navigation or dismissal", async () => {
    const preparation = deferred<void>();
    using f = fixture({
      prepare: async () => {
        await preparation.promise;
        throw new Error("Speech preparation failed");
      },
    });
    await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
    vi.useFakeTimers();
    await act(async () => preparation.resolve());
    expect(screen.getByRole("alert").textContent).toContain("Speech preparation failed");
    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Enter conversation mode" })).toBeDefined();
  });
  it("disabling speech hides its control, stops active audio and survives window restoration without losing voice configuration", async () => {
    using f = fixture();
    await f.enter();
    render(<SettingsSpeechSection speech={f.root.speechSettingsStore} />);
    await f.user.click(screen.getByRole("switch", { name: "Enable speech" }));
    expect(screen.getByRole("switch", { name: "Enable speech" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.queryByRole("button", { name: "Enter conversation mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exit conversation mode" })).toBeNull();
    expect(f.stopCapture).toHaveBeenCalled();
    expect(f.playback.stop).toHaveBeenCalled();
    await waitFor(() => expect(f.release).toHaveBeenCalled());
    const saved = toSnapshot(f.root);
    cleanup();
    f[Symbol.dispose]();

    using restored = fixture({ snapshot: saved });
    render(<SettingsSpeechSection speech={restored.root.speechSettingsStore} />);
    expect(screen.getByRole("switch", { name: "Enable speech" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.queryByRole("button", { name: "Enter conversation mode" })).toBeNull();
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe("voice");
    await restored.user.click(screen.getByRole("switch", { name: "Enable speech" }));
    await restored.enter();
    expect(screen.getByRole("button", { name: "Mute input", pressed: true })).toBeDefined();
    expect(restored.setApiKey).not.toHaveBeenCalled();
    expect(restored.setVoice).not.toHaveBeenCalled();
  });
  it("shows preparation in the speech icon until capture is ready, then replaces it with the listening ear", async () => {
    const preparation = deferred<void>();
    using f = fixture({ prepare: async () => preparation.promise });
    await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
    const control = screen.getByRole("button", { name: "Preparing conversation mode" });
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(control.querySelector('[role="status"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Exit conversation mode" })).toBeDefined();
    expect(f.microphone.open).not.toHaveBeenCalled();
    await act(async () => preparation.resolve());
    const ear = screen.getByRole("button", { name: "Mute input", pressed: true });
    expect(ear.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(f.microphone.open).toHaveBeenCalledOnce();
  });
  it("disabling speech during preparation prevents late completion from restarting audio or reporting an error", async () => {
    const preparation = deferred<void>();
    using f = fixture({ prepare: async () => preparation.promise });
    await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
    expect(
      screen.getByRole("button", { name: "Preparing conversation mode" }).getAttribute("aria-busy"),
    ).toBe("true");
    render(<SettingsSpeechSection speech={f.root.speechSettingsStore} />);
    await f.user.click(screen.getByRole("switch", { name: "Enable speech" }));
    await act(async () => preparation.resolve());
    expect(screen.queryByRole("button", { name: "Mute input" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter conversation mode" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.microphone.open).not.toHaveBeenCalled();
    expect(f.playback.start).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalled();
  });
  it("a speech pause finalizes recognition and submits one nonempty voice-mode turn to the same session", async () => {
    using f = fixture();
    await f.enter();
    await f.say();
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "one",
        text: "Recognized speech",
        responseMode: "voice",
        attachments: [],
      }),
      expect.any(Object),
    );
    expect(f.transcribe.mock.calls.filter(([input]) => input.final)).toHaveLength(1);
    await f.frames(0, 33);
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });
  it("uses detected quiet time for the one-second countdown delay and three-second send boundary", async () => {
    using f = fixture({ transcribe: async () => "First part and second part" });
    await f.enter();
    await f.detectorFrames(0.1, 2);
    await f.detectorFrames(0, 3); // 768 ms: not yet visible.
    expect(screen.queryByRole("button", { name: "Cancel automatic send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mute input" }).querySelector("circle")).toBeNull();
    await f.detectorFrames(0, 1); // 1024 ms: first frame past the delay.
    expect(
      Number(
        screen
          .getByRole("button", { name: "Cancel automatic send" })
          .querySelector("circle")
          ?.getAttribute("stroke-dashoffset"),
      ),
    ).toBeCloseTo(0.988);
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.transcribe.mock.calls.some(([request]) => request.final)).toBe(false);
    await f.detectorFrames(0.1, 2);
    expect(screen.queryByRole("button", { name: "Cancel automatic send" })).toBeNull();
    await f.detectorFrames(0, 3);
    expect(screen.queryByRole("button", { name: "Cancel automatic send" })).toBeNull();
    await f.detectorFrames(0, 5); // 2048 ms.
    expect(
      Number(
        screen
          .getByRole("button", { name: "Cancel automatic send" })
          .querySelector("circle")
          ?.getAttribute("stroke-dashoffset"),
      ),
    ).toBeCloseTo(0.476);
    await f.detectorFrames(0, 3); // 2816 ms: must not submit early.
    expect(f.prompt).not.toHaveBeenCalled();
    await f.detectorFrames(0, 1); // 3072 ms: first frame crossing three seconds.
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
    expect(f.prompt.mock.calls[0]![0].text).toBe("First part and second part");
    expect(new Set(f.transcribe.mock.calls.map(([request]) => request.utteranceId)).size).toBe(1);
    expect(f.transcribe.mock.calls.filter(([request]) => request.final)).toHaveLength(1);
    await f.detectorFrames(0, 12);
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });
  it("live transcription replaces partial words in the composer; cancelling retains them and resumed speech rearms the countdown", async () => {
    let text = "First";
    using f = fixture({ transcribe: async () => text });
    await f.enter();
    await f.frames(0.1, 8);
    const input = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    expect(input.value).toBe("First");
    text = "First thought";
    await f.frames(0.1, 8);
    expect(input.value).toBe("First thought");
    await f.frames(0, 20);
    const cancel = screen.getByRole("button", { name: "Cancel automatic send" });
    expect(Number(cancel.querySelector("circle")?.getAttribute("stroke-dashoffset"))).toBeCloseTo(
      0.5,
      1,
    );
    expect(f.prompt).not.toHaveBeenCalled();
    await f.user.click(cancel);
    await f.frames(0, 33);
    expect(input.value).toBe("First thought");
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.stopCapture).not.toHaveBeenCalled();
    text = "and more";
    await f.frames(0.1, 8);
    expect(input.value).toBe("First thought and more");
    await f.frames(0, 29);
    expect(screen.getByRole("button", { name: "Cancel automatic send" })).toBeDefined();
    expect(f.prompt).not.toHaveBeenCalled();
    await f.frames(0, 4); // Deliver the detector frame crossing the send boundary.
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
    expect(f.prompt.mock.calls[0]?.[0].text).toBe("First thought and more");
    expect(input.value).toBe("");
  });
  it("cancelling while final recognition is pending retains the corrected draft without sending", async () => {
    const final = deferred<string>();
    using f = fixture({ transcribe: async (request) => (request.final ? final.promise : "First") });
    await f.enter();
    await f.frames(0.1, 8);
    await f.frames(0, 33);
    const cancel = screen.getByRole("button", { name: "Cancel automatic send" });
    expect(cancel.querySelector("circle")?.getAttribute("stroke-dashoffset")).toBe("0");
    await f.user.click(cancel);
    await act(async () => final.resolve("First thought"));
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "First thought",
    );
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("manual edits seal a voice insertion rather than being overwritten or automatically sent", async () => {
    using f = fixture();
    await f.enter();
    await f.frames(0.1, 8);
    const input = screen.getByRole("combobox", { name: "Message" });
    await f.user.clear(input);
    await f.user.type(input, "My correction");
    await f.frames(0, 33);
    expect((input as HTMLTextAreaElement).value).toBe("My correction");
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("silence, brief noise and empty recognition do not submit or interrupt the assistant", async () => {
    using f = fixture({ transcribe: async () => "" });
    await f.enter();
    const stops = vi.mocked(f.playback.stop).mock.calls.length;
    await f.frames(0, 33);
    await f.frames(0.1, 1);
    await f.frames(0, 10);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops);
    expect(f.transcribe).not.toHaveBeenCalled();
    await f.frames(0.1, 4);
    await f.frames(0, 33);
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it.each([
    { betweenSentences: false, text: "" },
    { betweenSentences: true, text: "" },
    { betweenSentences: false, text: "all right" },
    { betweenSentences: true, text: "all right" },
  ])(
    "quiet onset preserves speech eligibility (between sentences: $betweenSentences, recognized: '$text')",
    async ({ betweenSentences, text }) => {
      using f = fixture({ streaming: true, transcribe: async () => text });
      await f.enter();
      f.publish([consumed()]);
      if (betweenSentences) {
        f.publish([consumed(), assistant("First sentence. ")]);
        await waitFor(() => expect(f.root.conversationModeStore.speaking).toBe(false));
        expect(f.synthesize).toHaveBeenCalledTimes(1);
      }
      const stops = vi.mocked(f.playback.stop).mock.calls.length;
      await f.frames(0.1, 8);
      await f.frames(0, 33);
      expect(f.transcribe).toHaveBeenCalled();
      expect(f.prompt).toHaveBeenCalledTimes(text ? 1 : 0);
      expect(f.playback.stop).toHaveBeenCalledTimes(stops);
      // A queued follow-up is not consumed yet; the original reply must still
      // speak without relying on a new user projection to restore eligibility.
      f.publish([
        consumed(),
        assistant(betweenSentences ? "First sentence. Still answering. " : "Still answering. "),
      ]);
      await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(betweenSentences ? 2 : 1));
      expect(f.synthesize.mock.calls.at(-1)?.[0].text).toBe("Still answering.");
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.microphone.open).toHaveBeenCalledTimes(1);
    },
  );
  it("retains detector-frame preroll including the speech onset before recognition", async () => {
    using f = fixture();
    await f.enter();
    await f.detectorFrames(0, 4);
    await f.detectorFrames(0.03, 2);
    await waitFor(() => expect(f.transcribe).toHaveBeenCalledTimes(1));
    const pcm = Buffer.from(f.transcribe.mock.calls[0]![0].pcm, "base64");
    const samples = Array.from({ length: pcm.byteLength / 4 }, (_, index) =>
      pcm.readFloatLE(index * 4),
    );
    expect(samples).toHaveLength(12_288);
    expect(samples.slice(0, 4096).every((value) => value === 0)).toBe(true);
    expect(samples.slice(4096).every((value) => value === Math.fround(0.03))).toBe(true);
    await f.detectorFrames(0, 12);
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
  });
  it.each([
    { name: "quieter speech", frames: [[0.02, 8]] },
    {
      name: "syllable gaps",
      frames: [
        [0.1, 2],
        [0, 1],
        [0.1, 2],
        [0, 1],
        [0.1, 2],
      ],
    },
  ] as const)(
    "accepts a follow-up with $name after output finishes without restarting capture",
    async ({ frames }) => {
      using f = fixture();
      await f.enter();
      const releases = f.release.mock.calls.length;
      await f.say();
      f.publish([consumed(), assistant("First answer. ")]);
      await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(f.root.conversationModeStore.speaking).toBe(false));
      for (const [value, count] of frames) await f.frames(value, count);
      await f.frames(0, 33);
      await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(2));
      expect(f.microphone.open).toHaveBeenCalledTimes(1);
      const finalCalls = f.transcribe.mock.calls.filter(([request]) => request.final);
      expect(finalCalls).toHaveLength(2);
      expect(finalCalls[0]![0].utteranceId).not.toBe(finalCalls[1]![0].utteranceId);
      expect(f.release).toHaveBeenCalledTimes(releases);
      expect(f.abort).not.toHaveBeenCalled();
    },
  );
  it("uses speech classification rather than loudness for onset and the send countdown", async () => {
    let speech = false;
    using f = fixture({ detectSpeech: async () => speech });
    await f.enter();
    await f.detectorFrames(0.8, 15); // Loud noise is not speech.
    expect(f.transcribe).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
    speech = true;
    await f.detectorFrames(0.001, 3); // Quiet speech is below both old volume cutoffs.
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Recognized speech",
    );
    speech = false;
    await f.detectorFrames(0.8, 11); // Background noise must not reset quiet time.
    expect(f.prompt).not.toHaveBeenCalled();
    await f.detectorFrames(0.8, 1);
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
  });
  it("rejects loud noise during output but accepts classified quiet speech as an explicit interruption", async () => {
    let speech: boolean | undefined;
    using f = fixture({
      detectSpeech: async (request) => speech ?? detectFixtureSpeech(request),
      transcribe: async () => "Stop!",
      drain: untilAborted,
    });
    await f.enter();
    await f.say();
    f.publish([consumed(), assistant("Still explaining the implementation. ")]);
    await waitFor(() => expect(f.playback.drain).toHaveBeenCalledTimes(1));
    const stops = vi.mocked(f.playback.stop).mock.calls.length;
    speech = false;
    await f.detectorFrames(0.8, 5);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops);
    speech = true;
    await f.detectorFrames(0.001, 3);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops + 1);
    speech = false;
    await f.detectorFrames(0.8, 12);
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(2));
  });
  it("discards a late detection result after mute and uses a fresh capture when unmuted", async () => {
    const gate = deferred<boolean>();
    const detection = vi
      .fn<Client["dictation"]["detectSpeech"]>()
      .mockImplementationOnce(async () => gate.promise)
      .mockImplementation(detectFixtureSpeech);
    using f = fixture({ detectSpeech: detection });
    await f.enter();
    await f.detectorFrames(0.1, 3);
    expect(detection).toHaveBeenCalledTimes(1);
    await f.user.click(screen.getByRole("button", { name: "Mute input" }));
    await act(async () => gate.resolve(true));
    expect(f.transcribe).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
    await f.user.click(screen.getByRole("button", { name: "Unmute input" }));
    await f.detectorFrames(0.1, 3);
    expect(detection.mock.calls.at(-1)?.[0].captureId).not.toBe(
      detection.mock.calls[0]?.[0].captureId,
    );
    expect((screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Recognized speech",
    );
  });
  it("speech composes with the typed draft, attachments and annotations through the normal composer", async () => {
    using f = fixture();
    const draft = f.session.conversationSessionStore.composerStore.draftStore;
    draft.setText("Typed draft");
    draft.restore("Typed draft", [{ kind: "file", name: "notes", path: "/notes" }]);
    draft.annotationDraft.add({
      messageId: "answer",
      selectedText: "a",
      startOffset: 0,
      endOffset: 1,
      contextBefore: "",
      contextAfter: "",
      comment: "Keep annotation",
    });
    const files = draft.visibleAttachments;
    await f.enter();
    await f.say();
    expect(f.prompt.mock.calls[0]?.[0].text).toContain("Typed draft Recognized speech");
    expect(f.prompt.mock.calls[0]?.[0].attachments).toEqual([
      ...files,
      expect.objectContaining({
        kind: "annotation",
        annotations: [expect.objectContaining({ comment: "Keep annotation" })],
      }),
    ]);
    expect(draft.text).toBe("");
  });
  it("a busy agent retains its tools and receives spoken input through its existing follow-up queue", async () => {
    using f = fixture({ streaming: true });
    await f.enter();
    await f.say();
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.session.model.streaming).toBe(true);
  });
  it("typed turns submitted during conversation mode carry voice response style; exiting restores text style", async () => {
    using f = fixture();
    await f.enter();
    await f.user.type(screen.getByRole("combobox", { name: "Message" }), "Typed voice");
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
    expect(f.prompt.mock.calls[0]?.[0].responseMode).toBe("voice");
    await f.user.click(screen.getByRole("button", { name: "Exit conversation mode" }));
    await f.user.type(screen.getByRole("combobox", { name: "Message" }), "Typed text");
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(2));
    expect(f.prompt.mock.calls[1]?.[0].responseMode).toBe("text");
  });
  it("only new assistant prose is synthesized in phrase order before the full answer completes", async () => {
    using f = fixture();
    await f.enter();
    f.publish([consumed(), assistant("First phrase. Second")]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    expect(f.synthesize.mock.calls[0]?.[0].text).toBe("First phrase.");
    f.publish([
      consumed(),
      assistant("First phrase. Second phrase.", "complete"),
      { id: "reason", kind: "reasoning", text: "Private thought", status: "complete" },
    ]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(2));
    expect(f.synthesize.mock.calls[1]?.[0].text).toBe("Second phrase.");
  });
  it("speaks a live completed reply even when no streaming projection was observed, but never replays durable reconnection history", async () => {
    using f = fixture();
    await f.enter();
    const project = createLiveMessageProjector();
    const input = { role: "user" as const, content: "A new request", timestamp: 100 };
    const reply = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A fast spoken answer." }],
      api: "openai-completions" as const,
      provider: "openai",
      model: "fixture",
      timestamp: 200,
      stopReason: "stop" as const,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const liveInput = project({ type: "message_start", message: input });
    project({ type: "message_start", message: reply });
    // Runtime coalescing can suppress all text deltas before message_end.
    const completed = project({ type: "message_end", message: reply });
    f.publish([...liveInput, ...completed]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    expect(f.synthesize.mock.calls[0]?.[0].text).toBe("A fast spoken answer.");
    const history = SessionManager.inMemory("/project");
    history.appendMessage(input);
    history.appendMessage(reply);
    history.appendMessage({
      ...reply,
      timestamp: 300,
      content: [{ type: "text", text: "An unseen historical answer." }],
    });
    const snapshot = projectConversationDisplay(history);
    f.publish(snapshot);
    expect(
      f.session.model.uiParts.some(
        (part) => part.kind === "text" && part.text === "An unseen historical answer.",
      ),
    ).toBe(true);
    await act(async () => {});
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });
  it("preserves comma context and synthesizes new sentences while earlier audio is still draining", async () => {
    using f = fixture({ drain: untilAborted });
    await f.enter();
    f.publish([consumed(), assistant("Hello, this isn't broken; it's one sentence. ")]);
    await waitFor(() => expect(f.playback.drain).toHaveBeenCalledTimes(1));
    expect(f.synthesize.mock.calls.map(([request]) => request.text)).toEqual([
      "Hello, this isn't broken; it's one sentence.",
    ]);
    const starts = vi.mocked(f.playback.start).mock.calls.length;
    f.publish([
      consumed(),
      assistant("Hello, this isn't broken; it's one sentence. Next sentence. "),
    ]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(2));
    expect(f.synthesize.mock.calls[1]?.[0].text).toBe("Next sentence.");
    expect(f.playback.enqueue).toHaveBeenCalledTimes(2);
    expect(f.playback.start).toHaveBeenCalledTimes(starts);
    expect(f.root.conversationModeStore.speaking).toBe(true);
    await f.user.click(screen.getByRole("button", { name: "Exit conversation mode" }));
    expect(f.root.conversationModeStore.speaking).toBe(false);
  });
  it("entering never speaks historical messages or the reply already running at entry", async () => {
    using f = fixture();
    f.publish([assistant("Already running", "streaming")]);
    await f.enter();
    f.publish([assistant("Already running. More.", "complete")]);
    expect(f.synthesize).not.toHaveBeenCalled();
  });
  it("live-to-settled projection changes and repeated snapshots never synthesize the same phrase twice", async () => {
    using f = fixture();
    await f.enter();
    f.publish([consumed(), assistant("Speak once. ")]);
    expect(f.session.model.parts.find((part) => part.value.id === "answer")?.value).toMatchObject({
      renderKey: "reply-1",
      status: "streaming",
    });
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    f.publish([consumed(), assistant("Speak once. ", "complete", "durable-entry")]);
    expect(
      f.session.model.parts.find((part) => part.value.id === "durable-entry")?.value,
    ).toMatchObject({
      renderKey: "reply-1",
      status: "complete",
    });
    f.publish([consumed(), assistant("Speak once. ", "complete", "durable-entry")]);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });
  it.each(["okay", "all right", "oh, I see", "don't stop", "the bus stop"])(
    "discards %s during output without silencing playback or submitting it",
    async (text) => {
      using f = fixture({ drain: untilAborted, transcribe: async () => text });
      await f.enter();
      f.publish([consumed(), assistant("Keep speaking. ")]);
      await waitFor(() => expect(f.playback.drain).toHaveBeenCalledTimes(1));
      const stops = vi.mocked(f.playback.stop).mock.calls.length;
      await f.frames(0.1, 8);
      expect(f.playback.stop).toHaveBeenCalledTimes(stops);
      await f.frames(0, 33);
      expect(f.transcribe.mock.calls.filter(([request]) => request.final)).toHaveLength(1);
      expect(f.playback.stop).toHaveBeenCalledTimes(stops);
      expect(f.root.conversationModeStore.speaking).toBe(true);
      expect(f.root.conversationModeStore.transcript).toBe("");
      expect(f.prompt).not.toHaveBeenCalled();
      expect(f.abort).not.toHaveBeenCalled();
    },
  );
  it.each(["Stop!", "WAIT.", "Please stop.", "please wait"])(
    "allows the short explicit command %s to interrupt",
    async (text) => {
      using f = fixture({ drain: untilAborted, transcribe: async () => text });
      await f.enter();
      f.publish([consumed(), assistant("Speaking. ")]);
      await waitFor(() => expect(f.playback.drain).toHaveBeenCalledTimes(1));
      const stops = vi.mocked(f.playback.stop).mock.calls.length;
      await f.frames(0.1, 2);
      expect(f.playback.stop).toHaveBeenCalledTimes(stops);
      await f.frames(0, 33);
      expect(f.playback.stop).toHaveBeenCalledTimes(stops + 1);
      expect(f.prompt.mock.calls[0]![0].text).toBe(text);
      expect(f.abort).not.toHaveBeenCalled();
    },
  );
  it("does not turn a tentative acknowledgment into a message when output finishes; ordinary short replies still work", async () => {
    const output = deferred<void>();
    using f = fixture({ drain: async () => output.promise, transcribe: async () => "all right" });
    await f.enter();
    f.publish([consumed(), assistant("First answer. ")]);
    await waitFor(() => expect(f.playback.drain).toHaveBeenCalledTimes(1));
    await f.frames(0.1, 8);
    await act(async () => output.resolve());
    await f.frames(0, 33);
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.root.conversationModeStore.transcript).toBe("");
    await f.say();
    expect(f.prompt.mock.calls[0]![0].text).toBe("all right");
    expect(f.microphone.open).toHaveBeenCalledTimes(1);
  });
  it("expires tentative speech after three seconds, rejects late words and accepts a fresh interruption without restarting recognition", async () => {
    const recognition = deferred<string>();
    using f = fixture({ drain: untilAborted, transcribe: async () => recognition.promise });
    await f.enter();
    f.publish([consumed(), assistant("Still speaking. ")]);
    await waitFor(() => expect(f.playback.drain).toHaveBeenCalledTimes(1));
    const stops = vi.mocked(f.playback.stop).mock.calls.length;
    const releases = f.release.mock.calls.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await f.frames(0.1, 8);
    expect(f.transcribe).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(f.root.conversationModeStore.transcript).toBe("");
    await act(async () => recognition.resolve("Actually change that approach"));
    await f.frames(0.1, 8);
    await f.frames(0, 33);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops);
    expect(f.prompt).not.toHaveBeenCalled();
    // A quiet boundary, not another three seconds of continuous noise, admits a fresh candidate.
    await f.frames(0.1, 8);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops + 1);
    await f.frames(0, 33);
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(releases);
    expect(f.microphone.open).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it.each(["mute", "exit"] as const)(
    "%s discards a pending interruption and its timer without accepting late recognition",
    async (action) => {
      const recognition = deferred<string>();
      let calls = 0;
      using f = fixture({
        drain: untilAborted,
        transcribe: async () => (++calls === 1 ? "all right" : recognition.promise),
      });
      await f.enter();
      f.publish([consumed(), assistant("Speaking. ")]);
      await waitFor(() => expect(f.playback.drain).toHaveBeenCalledTimes(1));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      await f.frames(0.1, 8);
      expect(f.root.conversationModeStore.transcript).toBe("all right");
      await f.frames(0.1, 8);
      expect(vi.getTimerCount()).toBe(1);
      // Synchronous UI dispatch keeps this timer/cancellation test independent of user-event delays.
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "mute" ? "Mute input" : "Exit conversation mode",
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(f.root.conversationModeStore.transcript).toBe("");
      const stops = vi.mocked(f.playback.stop).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        recognition.resolve("Actually change that approach");
      });
      expect(f.playback.stop).toHaveBeenCalledTimes(stops);
      expect(f.prompt).not.toHaveBeenCalled();
      expect(f.abort).not.toHaveBeenCalled();
      vi.useRealTimers();
    },
  );
  it("barge-in waits for four recognized words before silencing playback and rejects late synthesis without aborting agent work", async () => {
    const gate = deferred<void>();
    const recognition = deferred<string>();
    let consume: Parameters<Client["speechOutput"]["synthesize"]>[1] | undefined;
    using f = fixture({
      transcribe: async (request) =>
        request.final ? "Actually change that approach please" : recognition.promise,
      synthesize: async (_request, callback) => {
        consume = callback;
        await gate.promise;
      },
    });
    await f.enter();
    f.publish([consumed(), assistant("Speaking. ")]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    const stops = vi.mocked(f.playback.stop).mock.calls.length;
    await f.frames(0.02, 10);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops);
    await f.frames(0.1, 8);
    expect(f.transcribe).toHaveBeenCalledTimes(1);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops);
    await act(async () => recognition.resolve("Actually change that approach"));
    expect(f.playback.stop).toHaveBeenCalledTimes(stops + 1);
    await consume?.({ encoding: "pcm_s16le", sampleRate: 24000, pcm: "AAA=" });
    expect(f.playback.enqueue).not.toHaveBeenCalled();
    expect(f.abort).not.toHaveBeenCalled();
    await f.frames(0, 33);
    await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
    expect(f.prompt.mock.calls[0]![0].text).toBe("Actually change that approach please");
    gate.resolve();
  });
  it("barge-in suppresses the interrupted reply until the next user input is consumed rather than merely queued", async () => {
    using f = fixture({
      drain: untilAborted,
      transcribe: async () => "Actually change that approach",
    });
    await f.enter();
    f.publish([consumed(), assistant("Old. ")]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    await f.frames(0.1, 8);
    f.publish([
      consumed(),
      assistant("Old. Still old. "),
      { ...consumed("queued"), deliveryState: "queued" },
    ]);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    f.publish([
      consumed(),
      assistant("Old. Still old. ", "complete"),
      consumed("consumed-next"),
      { ...assistant("New. "), renderKey: "new-reply", id: "new-answer" },
    ]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(2));
    expect(f.synthesize.mock.calls[1]?.[0].text).toBe("New.");
  });
  it.each([
    "Repeat this request",
    '<skill name="fixture" location="/fixture/SKILL.md">\nInstructions\n</skill>\nRepeat this request',
  ])(
    "a settled projection of the same consumed input cannot undo barge-in (%s)",
    async (content) => {
      using f = fixture({
        drain: untilAborted,
        transcribe: async () => "Actually change that approach",
      });
      const history = SessionManager.inMemory("/project");
      const project = createLiveMessageProjector();
      const input = { role: "user" as const, content, timestamp: 100 };
      const live = project({ type: "message_start", message: input });
      await f.enter();
      f.publish([...live, assistant("Old answer. ")]);
      await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
      await f.frames(0.1, 8);
      history.appendMessage(input);
      const settled = projectConversationDisplay(history);
      f.publish([
        ...settled,
        assistant("Old answer. Interrupted remainder. "),
        { ...consumed("queued"), deliveryState: "queued" },
      ]);
      await act(async () => {});
      expect(f.synthesize.mock.calls.map(([request]) => request.text)).toEqual(["Old answer."]);

      // Identical words in a genuinely new Pi message still unlock its entire response.
      const next = { ...input, timestamp: 200 };
      const nextLive = project({ type: "message_start", message: next });
      f.publish([
        ...settled,
        assistant("Old answer. Interrupted remainder. ", "complete", "settled-answer"),
        ...nextLive,
        { ...assistant("Next answer starts here. "), id: "next-answer", renderKey: "reply-2" },
      ]);
      await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(2));
      expect(f.synthesize.mock.calls.map(([request]) => request.text)).toEqual([
        "Old answer.",
        "Next answer starts here.",
      ]);
      expect(f.session.model.uiParts.find((part) => part.id === "next-answer")).toMatchObject({
        text: "Next answer starts here. ",
      });
    },
  );
  it("muting stops and discards unfinished input while allowing output and accepted agent work to continue", async () => {
    using f = fixture();
    await f.enter();
    await f.frames(0.1, 4);
    await f.user.click(screen.getByRole("button", { name: "Mute input" }));
    await f.frames(0, 10);
    expect(f.prompt).not.toHaveBeenCalled();
    f.publish([consumed(), assistant("Output while muted. ")]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("mute during native-like in-flight recognition re-prepares the invalidated worker before the next utterance", async () => {
    let ready = false;
    let first = true;
    const started = deferred<void>();
    const prepare = vi.fn<Client["dictation"]["prepare"]>(async () => {
      ready = true;
    });
    using f = fixture({
      prepare,
      transcribe: async (request, options) => {
        if (!ready) throw new Error("The speech model is not ready");
        if (first) {
          first = false;
          started.resolve();
          return new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                // Mirrors DictationLive interruption: abort closes/resets the worker.
                ready = false;
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        return request.final ? "Recognized after mute" : "Progress";
      },
    });
    await f.enter();
    await f.frames(0.1, 8);
    await started.promise;
    await f.user.click(screen.getByRole("button", { name: "Mute input" }));
    expect(ready).toBe(false);
    expect(f.root.conversationModeStore.phase).toBe("active");
    await f.user.click(screen.getByRole("button", { name: "Unmute input" }));
    await waitFor(() => expect(f.microphone.open).toHaveBeenCalledTimes(2));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(ready).toBe(true);
    await f.say();
    expect(f.prompt.mock.calls[0]?.[0]).toMatchObject({
      text: "Recognized after mute",
      responseMode: "voice",
    });
    expect(f.root.conversationModeStore.phase).toBe("active");
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("re-mute or exit during unmute preparation invalidates it and never opens late capture", async () => {
    for (const action of ["remute", "exit"] as const) {
      const gate = deferred<void>();
      let calls = 0;
      let signal: AbortSignal | undefined;
      using f = fixture({
        prepare: async (options) => {
          if (++calls === 1) return;
          signal = options?.signal;
          await gate.promise;
        },
      });
      await f.enter();
      await f.user.click(screen.getByRole("button", { name: "Mute input" }));
      await f.user.click(screen.getByRole("button", { name: "Unmute input" }));
      await waitFor(() => expect(calls).toBe(2));
      expect(signal?.aborted).toBe(false);
      expect(f.root.conversationModeStore.listening).toBe(false);
      await f.user.click(
        screen.getByRole("button", {
          name: action === "remute" ? "Mute input" : "Exit conversation mode",
        }),
      );
      expect(signal?.aborted).toBe(true);
      gate.resolve();
      await act(async () => {
        await gate.promise;
      });
      expect(f.microphone.open).toHaveBeenCalledTimes(1);
      expect(f.root.conversationModeStore.listening).toBe(false);
      expect(f.root.conversationModeStore.phase).toBe(action === "remute" ? "active" : "off");
      if (action === "remute") {
        await f.user.click(screen.getByRole("button", { name: "Unmute input" }));
        await waitFor(() => expect(f.microphone.open).toHaveBeenCalledTimes(2));
        expect(f.root.conversationModeStore.listening).toBe(true);
      }
      expect(f.abort).not.toHaveBeenCalled();
    }
  });
  it("nested fenced code never reaches synthesis while following streamed prose resumes exactly once", async () => {
    using f = fixture();
    await f.enter();
    let text = "";
    for (const chunk of [
      "``",
      "``markdown\n",
      "```ts\nSecret code sentence.\n",
      "```\nMore secret code.\n",
      "````not-a-close\nStill secret.\n",
    ]) {
      text += chunk;
      await act(async () => f.publish([consumed(), assistant(text)]));
      expect(f.synthesize).not.toHaveBeenCalled();
    }
    text += "`````  \nFollowing prose.\n";
    f.publish([consumed(), assistant(text)]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    f.publish([consumed(), assistant(text, "complete", "durable-entry")]);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.synthesize.mock.calls[0]?.[0].text).toBe("Following prose.");
  });
  it("selection change, blur, exit and disposal discard late recognition and release capture and playback", async () => {
    for (const action of ["selection", "blur", "exit", "disposal"] as const) {
      const gate = deferred<string>();
      const f = fixture({ transcribe: async () => gate.promise });
      await f.enter();
      await f.frames(0.1, 8);
      await f.frames(0, 33);
      if (action === "selection") act(() => f.root.appShellStore.showSettings());
      else if (action === "disposal") f.root[Symbol.dispose]();
      else
        await act(async () => {
          await f.root.conversationModeStore.exit();
        }); // Bootstrap routes blur to this same intent; Electron proves the native event.
      gate.resolve("Late text");
      await act(async () => {
        await gate.promise;
      });
      expect(f.prompt).not.toHaveBeenCalled();
      expect(f.stopCapture).toHaveBeenCalled();
      expect(f.playback.stop).toHaveBeenCalled();
      expect(f.release).toHaveBeenCalled();
      f[Symbol.dispose]();
    }
  });
  it("voice mode suppresses only its composer while dictation stays enabled and resumes after exit", async () => {
    using f = fixture();
    act(() => f.root.dictationStore.applyState({ ...installedDictationState, status: "ready" }));
    render(
      <SettingsDictationSection
        store={f.root.dictationStore}
        prompts={f.root.settingsStore.cakePrompts}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Dictation mode" });
    await f.user.click(toggle);
    const input = screen.getByRole("combobox", { name: "Message" });
    await f.user.click(input);
    await waitFor(() => expect(f.root.dictationStore.phase).toBe("listening"));
    await f.enter();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await f.user.click(input);
    expect(
      screen.queryByText("Listening", { selector: '[data-slot="dictation-indicator"]' }),
    ).toBeNull();
    const opens = vi.mocked(f.microphone.open).mock.calls.length;
    await f.frames(0.1, 8);
    expect((input as HTMLTextAreaElement).value).toBe("Recognized speech");
    expect(f.microphone.open).toHaveBeenCalledTimes(opens);
    await f.user.click(screen.getByRole("button", { name: "Exit conversation mode" }));
    await f.user.click(input);
    await waitFor(() => expect(f.root.dictationStore.phase).toBe("listening"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(f.microphone.open).toHaveBeenCalledTimes(opens + 1);
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("turning dictation on or off does not disable voice mode or release its recognizer", async () => {
    using f = fixture();
    act(() => f.root.dictationStore.applyState({ ...installedDictationState, status: "ready" }));
    render(
      <SettingsDictationSection
        store={f.root.dictationStore}
        prompts={f.root.settingsStore.cakePrompts}
      />,
    );
    await f.enter();
    const releases = f.release.mock.calls.length;
    const toggle = screen.getByRole("switch", { name: "Dictation mode" });
    await f.user.click(toggle);
    expect(f.root.conversationModeStore.phase).toBe("active");
    await f.user.click(toggle);
    expect(f.root.conversationModeStore.phase).toBe("active");
    expect(f.release).toHaveBeenCalledTimes(releases);
  });
  it("recognition backlog or output quota failure stops voice resources, preserves agent work and exposes recoverable text", async () => {
    const gate = deferred<string>();
    using f = fixture({ transcribe: async () => gate.promise });
    await f.enter();
    await f.frames(0.1, 100);
    expect(f.root.conversationModeStore.phase).toBe("error");
    expect(f.abort).not.toHaveBeenCalled();
    gate.resolve("Ignored");
    f[Symbol.dispose]();
    using quota = fixture({
      synthesize: async () => {
        throw new Error("Quota exhausted");
      },
    });
    await quota.enter();
    quota.publish([consumed(), assistant("Visible answer. ")]);
    expect((await screen.findByRole("alert")).textContent).toContain("Quota exhausted");
    expect(quota.abort).not.toHaveBeenCalled();
    expect(
      quota.session.model.uiParts.some(
        (part) => part.kind === "text" && part.text === "Visible answer. ",
      ),
    ).toBe(true);
  });
  it.each([
    ["invalid PCM", "ElevenLabs returned invalid PCM audio. No automatic retry was made."],
    ["network", "Could not connect to ElevenLabs."],
    ["playback", "Audio playback failed."],
  ])(
    "%s runtime errors appear as dismissible toasts and leave text chat usable",
    async (kind, message) => {
      const fail = async () => {
        throw new Error(message);
      };
      using f = fixture(kind === "playback" ? { enqueue: fail } : { synthesize: fail });
      await f.enter();
      f.publish([consumed(), assistant("Visible answer. ")]);
      expect((await screen.findByRole("alert")).textContent).toContain(message);
      expect(f.stopCapture).toHaveBeenCalled();
      expect(f.playback.stop).toHaveBeenCalled();
      expect(f.synthesize).toHaveBeenCalledTimes(1);
      expect(f.abort).not.toHaveBeenCalled();
      await f.user.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(screen.queryByRole("alert")).toBeNull();
      await f.user.type(screen.getByRole("combobox", { name: "Message" }), "Continue in text");
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(f.synthesize).toHaveBeenCalledTimes(1);
    },
  );
  it("reports a successful-but-empty synthesis instead of silently leaving voice mode active", async () => {
    using f = fixture({ synthesize: async () => {} });
    await f.enter();
    f.publish([consumed(), assistant("Visible answer. ")]);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The speech provider returned no audio",
    );
    expect(f.root.conversationModeStore.phase).toBe("error");
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
    await f.user.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByRole("alert").textContent).toContain("synthesis-complete");
  });
  it("copies a metadata-only trace of successful speech from settings without synthesizing a preview", async () => {
    using f = fixture();
    await f.enter();
    f.publish([consumed(), assistant("Private spoken answer. ")]);
    await waitFor(() => expect(f.playback.drain).toHaveBeenCalled());
    render(<SettingsSpeechSection speech={f.root.speechSettingsStore} />);
    await f.user.click(screen.getByRole("button", { name: "Copy voice diagnostics" }));
    await screen.findByRole("button", { name: "Voice diagnostics copied" });
    const report = await navigator.clipboard.readText();
    expect(report).toContain("first-audio");
    expect(report).toContain("synthesis-complete");
    expect(report).not.toContain("Private spoken answer");
    expect(report).not.toContain("New request");
    expect(report).not.toContain('"voiceId"');
    expect(report).not.toContain('"pcm"');
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });
  it("retains unaccepted recognized text in the error toast details for manual recovery", async () => {
    using f = fixture({
      synthesize: async () => {
        throw new Error("Invalid audio");
      },
    });
    await f.enter();
    await f.frames(0.1, 8);
    await waitFor(() => expect(f.root.conversationModeStore.transcript).toBe("Recognized speech"));
    f.publish([consumed(), assistant("Visible answer. ")]);
    await screen.findByRole("alert");
    await f.user.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByRole("alert").textContent).toContain("Unaccepted speech: Recognized speech");
    expect(screen.getByRole("button", { name: "Copy full error details" })).toBeDefined();
    await f.user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("enters and speaks with installed local output without an ElevenLabs key", async () => {
    using f = fixture();
    act(() =>
      f.root.speechSettingsStore.applySettings(
        speechOutputSettings({
          provider: "pocket-tts",
          modelId: "pocket-tts-coreml",
          keyConfigured: false,
          voiceId: "alba",
          voices: [{ id: "alba", name: "Alba" }],
          localModel: pocketTtsState({ selected: true, installed: true }),
        }),
      ),
    );
    await f.enter();
    f.publish([consumed(), assistant("Speaking locally. ")]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    expect(f.synthesize.mock.calls[0]?.[0].text).toBe("Speaking locally.");
    expect(f.playback.enqueue).toHaveBeenCalledTimes(1);
    expect(f.setApiKey).not.toHaveBeenCalled();
  });
  it.each([
    { name: "not installed", installed: false, engineAvailable: true, installing: false },
    { name: "engine missing", installed: true, engineAvailable: false, installing: false },
    { name: "installation in progress", installed: true, engineAvailable: true, installing: true },
  ])("blocks unready local output ($name) even when the cloud key is configured", async (model) => {
    using f = fixture();
    act(() =>
      f.root.speechSettingsStore.applySettings(
        speechOutputSettings({
          provider: "pocket-tts",
          modelId: "pocket-tts-coreml",
          keyConfigured: true,
          voiceId: "alba",
          localModel: pocketTtsState({
            selected: true,
            installed: model.installed,
            engineAvailable: model.engineAvailable,
            installing: model.installing,
          }),
        }),
      ),
    );
    await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
    await screen.findByText(
      "Download Pocket TTS in Settings → Voice & Dictation before entering voice mode.",
    );
    expect(f.synthesize).not.toHaveBeenCalled();
    expect(f.playback.start).not.toHaveBeenCalled();
    await f.user.type(screen.getByRole("combobox", { name: "Message" }), "Text still works");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
  it.each(["elevenlabs", "pocket-tts"] as const)(
    "the %s speed slider commits through the service and reflects its authoritative projection",
    async (provider) => {
      using f = fixture();
      if (provider === "pocket-tts")
        act(() =>
          f.root.speechSettingsStore.applySettings(
            speechOutputSettings({
              provider,
              modelId: "pocket-tts-coreml",
              keyConfigured: false,
              voiceId: "alba",
              localModel: pocketTtsState({ selected: true, installed: true }),
            }),
          ),
        );
      render(<SettingsSpeechSection speech={f.root.speechSettingsStore} />);
      const slider = screen.getByRole("slider", { name: "Speaking speed" });
      expect(slider.getAttribute("min")).toBe("1");
      expect(slider.getAttribute("max")).toBe(provider === "pocket-tts" ? "2" : "1.2");
      fireEvent.change(slider, { target: { value: "1.15" } });
      expect(screen.getByText("1.15×")).toBeDefined();
      fireEvent.pointerUp(slider);
      await waitFor(() => expect(f.setSpeed).toHaveBeenCalledWith(1.15, expect.any(Object)));
      expect((slider as HTMLInputElement).value).toBe("1.15");
      expect(f.synthesize).not.toHaveBeenCalled();
    },
  );
  it("speech settings save a masked transient key, clear its draft and select a voice without exposing stored credentials", async () => {
    using f = fixture();
    render(<SettingsSpeechSection speech={f.root.speechSettingsStore} />);
    const key = screen.getByLabelText("ElevenLabs API key");
    expect(key.getAttribute("type")).toBe("password");
    await f.user.type(key, "transient-key");
    await f.user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(f.root.speechSettingsStore.apiKeyDraft).toBe(""));
    expect(f.setApiKey).toHaveBeenCalledWith("transient-key", expect.any(Object));
    await f.user.click(screen.getByRole("button", { name: "Refresh voices" }));
    await screen.findByText("Fixture voice");
    await f.user.selectOptions(screen.getByLabelText("Voice"), "voice");
    expect(f.setVoice).toHaveBeenCalledWith("voice", expect.any(Object));
    expect(f.synthesize).not.toHaveBeenCalled();
  });
});
