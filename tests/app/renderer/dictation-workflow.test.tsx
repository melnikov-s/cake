/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TurnId,
  type ConversationEvent,
} from "../../../src/contracts/conversations/conversation-data";
import {
  DICTATION_PREPARATION_TIMEOUT_MS,
  DictationError,
  type DictationAudio,
  type DictationErrorCode,
  type DictationState,
} from "../../../src/contracts/dictation/dictation-data";
import { useAppHotkeys } from "../../../src/renderer/hooks/use-app-hotkeys";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { ClientError } from "../../../src/renderer/client/Client";
import { voiceDiagnosticReport } from "../../../src/renderer/speech/diagnostics";
import { builtinSlashCommands } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { AnnotationDraftPopover } from "../../../src/renderer/components/annotation-draft-popover";
import { AnnotationItemPopover } from "../../../src/renderer/components/annotation-item-popover";
import { SettingsDictationSection } from "../../../src/renderer/components/settings-dictation-section";
import { SettingsSpeechInputSection } from "../../../src/renderer/components/settings-speech-input-section";
import { WindowStatePersistence } from "../../../src/renderer/persistence/WindowStatePersistence";
import type { TestClientOverrides } from "./test-client";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import {
  changeVocabulary,
  emptyVocabulary,
  listVocabulary,
} from "../../../src/contracts/dictation/vocabulary";
import { installedDictationState } from "../../helpers/dictation";
import { detectFixtureSpeech } from "../../helpers/speech-detection";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { speechCleanupFixture } from "../helpers/speechCleanup";

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
function browserAudio(options: {
  permission?: Promise<void>;
  microphoneReady?: Promise<void>;
  flushReady?: Promise<void>;
}) {
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
        if (message === "flush") {
          if (options.flushReady) void options.flushReady.then(() => this.emit("flushed"));
          else this.emit("flushed");
        }
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

function DictationHotkeys({ root }: { root: RootStore }) {
  useAppHotkeys(root, () => {});
  return null;
}

function renderDictation(
  options: {
    hotkeys?: boolean;
    modelReady?: Promise<void>;
    surface?: "project-session" | "project-chat" | "cake-chat";
    slashCommands?: boolean;
    submissionReady?: Promise<void>;
    composerFocusEnabled?: boolean;
    parkComposerFocusWhileDictating?: boolean;
    permission?: Promise<void>;
    microphoneReady?: Promise<void>;
    flushReady?: Promise<void>;
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
    const current = fixture.root.dictationStore.state;
    fixture.root.dictationStore.applyState({
      ...installedDictationState,
      ...options.state,
      muted: current?.muted ?? false,
      captureOwner: current?.captureOwner,
      captureClaim: current?.captureClaim ?? 0,
      status: "ready",
    });
  });
  // The main process echoes shared capture ownership and mute to every window.
  const shared = (change: Partial<DictationState>) =>
    fixture.root.dictationStore.applyState({ ...fixture.root.dictationStore.state!, ...change });
  const claim = vi.fn<Client["dictation"]["claim"]>(async ({ owner }) => {
    const next = fixture.root.dictationStore.state!.captureClaim + 1;
    shared({ captureOwner: owner, captureClaim: next });
    return { claim: next };
  });
  const setMuted = vi.fn<Client["dictation"]["setMuted"]>(async ({ muted }) => shared({ muted }));
  const release = vi.fn<Client["dictation"]["release"]>(async () => undefined);
  const trace = vi.fn<Client["dictation"]["trace"]>(async () => undefined);
  const transcribe = vi.fn<Client["dictation"]["transcribe"]>((input) => {
    const reply = deferred<string>();
    requests.push({ audio: input, reply });
    return reply.promise;
  });
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
    await options.submissionReady;
    return TurnId.make("10000000-0000-4000-8000-000000000001");
  });
  const sessionId =
    options.surface === "project-chat"
      ? "project-chat:dictation"
      : options.surface === "cake-chat"
        ? "cake-chat:dictation"
        : "dictation-session";
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [
      sessionSummary({ sessionId, projectPath: "/project" }),
      sessionSummary({ sessionId: "other-dictation-session", projectPath: "/project" }),
    ],
    snapshot: options.snapshot,
    client: {
      ...options.client,
      dictation: {
        listVocabulary: async () => ({ revision: 0, entries: [], total: 0, nextOffset: null }),
        prepare,
        release,
        trace,
        claim,
        setMuted,
        transcribe,
        detectSpeech: detectFixtureSpeech,
        ...options.client?.dictation,
      },
      workspaces: { postProcessDictation: async (text) => text, ...options.client?.workspaces },
      sessionChats: { prompt, ...options.client?.sessionChats },
    },
  });
  const isCakeChat = options.surface === "project-chat" || options.surface === "cake-chat";
  if (isCakeChat)
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId, title: "Dictation chat" }],
    });
  let session = isCakeChat
    ? fixture.root.cakeChatCollectionStore.registry.load(sessionId)
    : fixture.root.sessionRegistry.load(sessionId, "/project");
  if (isCakeChat) fixture.root.navigationStore.selectCakeChat(sessionId);
  else {
    fixture.root.navigationStore.selectProjectSession(sessionId);
    fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  }
  fixture.root.dictationStore.applyState({
    ...installedDictationState,
    status: options.modelReady ? "loading" : "ready",
    ...options.state,
  });
  const initialUpdate = {
    _tag: "Snapshot" as const,
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
      commands: options.slashCommands ? builtinSlashCommands : [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  } satisfies Parameters<typeof applyConversationUpdate>[1];
  applyConversationUpdate(session.model, initialUpdate);
  let revision = 1;
  const surface = (composerKey: number) => (
    <StoreProvider store={fixture.root.dictationStore}>
      {options.hotkeys && <DictationHotkeys root={fixture.root} />}
      <SettingsDictationSection
        store={fixture.root.settingsStore.dictation}
        prompts={fixture.root.settingsStore.cakePrompts}
        cleanup={fixture.root.settingsStore.speechCleanup}
      />
      <Chat
        key={composerKey}
        parkComposerFocusWhileDictating={options.parkComposerFocusWhileDictating}
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={options.composerFocusEnabled ?? false}
      />
    </StoreProvider>
  );
  let composerKey = 0;
  const view = render(surface(composerKey));
  return {
    remountComposer() {
      view.rerender(surface(++composerKey));
    },
    switchProjectSession() {
      const nextId = "other-dictation-session";
      session = fixture.root.sessionRegistry.load(nextId, "/project");
      applyConversationUpdate(session.model, {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          ...initialUpdate.snapshot,
          sessionId: nextId,
          sessionFile: `/project/${nextId}.jsonl`,
        },
      });
      fixture.root.navigationStore.selectProjectSession(nextId);
      fixture.root.projectWorkbenchStore.showLoadedSession(nextId);
      view.rerender(surface(composerKey));
    },
    user: userEvent.setup(),
    root: fixture.root,
    client: fixture.client,
    audio,
    prepare,
    release,
    trace,
    claim,
    setMuted,
    /** Another window's change arriving through the shared main-process state. */
    otherWindow(change: { claim?: true; muted?: boolean }) {
      act(() =>
        shared({
          ...(change.muted === undefined ? {} : { muted: change.muted }),
          ...(change.claim
            ? {
                captureOwner: "other-window",
                captureClaim: fixture.root.dictationStore.state!.captureClaim + 1,
              }
            : {}),
        }),
      );
    },
    requests,
    prompt: options.client?.sessionChats?.prompt ?? prompt,
    submitContract: () => session.conversationSessionStore.chatStore.submit(),
    publish(event: ConversationEvent) {
      act(() =>
        applyConversationUpdate(session.model, { _tag: "Event", revision: ++revision, event }),
      );
    },
    requestFocus() {
      act(() => session.conversationSessionStore.composerStore.draftStore.requestFocus());
    },
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
const engineFailure = (
  code: DictationErrorCode = "engine-timeout",
  message = "Engine interrupted",
) =>
  new ClientError("rejected", "dictation.transcribe", message, "private details", {
    dictationFailure: new DictationError({ code, message }),
  });
const advanceRecovery = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const endMicrophone = async (f: ReturnType<typeof renderDictation>) => {
  await act(async () => {
    f.audio.tracks.at(-1)!.dispatchEvent(new Event("ended"));
  });
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Dictation writing-field workflow", () => {
  async function voiceSend(f: ReturnType<typeof renderDictation>, phrase?: string) {
    render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
    await f.user.click(screen.getByRole("switch", { name: "Submit message by voice" }));
    if (phrase !== undefined)
      fireEvent.change(screen.getByRole("textbox", { name: "Submit phrase" }), {
        target: { value: phrase },
      });
    await f.user.click(mode());
    await f.user.click(message());
    listening();
    // An actual leading acoustic boundary, not a recognizer packet or timer.
    await f.audio.push(new Float32Array(49_152));
  }

  async function addFilter(f: ReturnType<typeof renderDictation>, text = "Yeah.") {
    fireEvent.change(screen.getByRole("textbox", { name: "Discard phrase" }), {
      target: { value: text },
    });
    await f.user.click(screen.getByRole("button", { name: "Add filter" }));
  }

  it.each(["raw", "utility"] as const)(
    "filters finalized whole utterances in %s, preserving typed text, lowercase and successive sentences",
    async (processing) => {
      let text = "";
      const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async () => text);
      using f = renderDictation({ client: { dictation: { transcribe } } });
      await f.user.selectOptions(
        screen.getByRole("combobox", { name: "Text processing" }),
        processing,
      );
      render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
      await addFilter(f);
      await f.user.click(mode());
      await f.user.type(message(), "Typed Yeah. stays.");
      const say = async (words: string) => {
        text = words;
        await f.audio.push(new Float32Array(16_384).fill(0.1));
        await f.audio.push(new Float32Array(24_576));
      };
      text = "Yeah.";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      expect(message().value).toBe("Typed Yeah. stays. Yeah."); // interim stays visible
      await f.audio.push(new Float32Array(24_576));
      expect(message().value).toBe("Typed Yeah. stays."); // equal final still removes interim
      await say("yeah");
      await say("Yeah. this stays.");
      await say("I said yeah yesterday.");
      await say("Yeah.");
      expect(message().value).toBe(
        "Typed Yeah. stays. yeah Yeah. this stays. I said yeah yesterday.",
      );
      expect(f.prompt).not.toHaveBeenCalled();
      expect(transcribe.mock.calls.filter(([input]) => input.final)).toHaveLength(5);
      listening();
    },
  );

  it("adds, edits, removes and restores filters through Settings, applying changes to active capture", async () => {
    let text = "";
    using f = renderDictation({
      client: {
        dictation: {
          transcribe: async ({ final }) => {
            const result = text;
            if (final) text = ""; // Native finalization releases the rolling transcript.
            return result;
          },
        },
      },
    });
    render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
    await f.user.click(mode());
    await f.user.type(message(), "Draft");
    await addFilter(f);
    await waitFor(listening);
    const say = async (words: string) => {
      text = words;
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      await f.audio.push(new Float32Array(24_576));
    };
    await say("Yeah.");
    expect(message().value).toBe("Draft");
    await f.user.click(screen.getByRole("button", { name: "Edit Yeah." }));
    fireEvent.change(screen.getByRole("textbox", { name: "Discard phrase" }), {
      target: { value: "No thanks." },
    });
    await f.user.click(screen.getByRole("switch", { name: /^Match case$/ }));
    await f.user.click(screen.getByRole("button", { name: "Save filter" }));
    using restored = createRendererStoreFixture({ snapshot: toSnapshot(f.root) });
    expect(restored.root.speechInputSettingsStore.values.dictationDiscardFilters).toEqual([
      { text: "No thanks.", matchCase: false },
    ]);
    await say("no thanks");
    await say("Yeah.");
    expect(message().value).toBe("Draft Yeah.");
    await f.user.click(screen.getByRole("button", { name: "Remove No thanks." }));
    await waitFor(listening);
    await say("no thanks");
    expect(message().value).toBe("Draft Yeah. no thanks");
    using removed = createRendererStoreFixture({ snapshot: toSnapshot(f.root) });
    expect(removed.root.speechInputSettingsStore.values.dictationDiscardFilters).toEqual([]);
  });

  it("does not filter a matching interim followed by nonmatching final or utility output", async () => {
    let interim = "Yeah.";
    let finalText = "Yeah, carry on.";
    using f = renderDictation({
      client: {
        dictation: { transcribe: async ({ final }) => (final ? finalText : interim) },
        workspaces: { postProcessDictation: async () => "Yeah." },
      },
    });
    render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
    await addFilter(f);
    await f.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await f.user.click(mode());
    await f.user.type(message(), "Typed");
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    expect(message().value).toBe("Typed Yeah.");
    await f.audio.push(new Float32Array(24_576));
    expect(message().value).toBe("Typed Yeah."); // cleanup output must stay
    interim = "yeah";
    finalText = "yeah";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(24_576));
    expect(message().value).toBe("Typed Yeah. Yeah.");
  });

  it("does not let a stale finalized filter callback erase a subsequent manual edit", async () => {
    const finalReply = deferred<string>();
    const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async ({ final }) =>
      final ? finalReply.promise : "Yeah.",
    );
    using f = renderDictation({ client: { dictation: { transcribe } } });
    render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
    await addFilter(f);
    await f.user.click(mode());
    await f.user.type(message(), "Draft");
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    const flush = f.audio.push(new Float32Array(24_576));
    await waitFor(() => expect(transcribe.mock.calls.some(([input]) => input.final)).toBe(true));
    fireEvent.change(message(), { target: { value: "Manually replaced draft" } });
    finalReply.resolve("Yeah.");
    await flush;
    expect(message().value).toBe("Manually replaced draft");
    listening();
  });

  it("filters manual finalization before ordinary submit without submitting by voice", async () => {
    using f = renderDictation({ client: { dictation: { transcribe: async () => "Yeah." } } });
    render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
    await addFilter(f);
    await f.user.click(mode());
    await f.user.type(message(), "Typed draft.");
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.user.keyboard("{Enter}");
    await waitFor(() =>
      expect(f.prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Typed draft." }),
        expect.anything(),
      ),
    );
  });

  it("lets voice submit take precedence over matching discard rules and keeps prior filtered utterances out of submission", async () => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f);
    await addFilter(f);
    await addFilter(f, "Send it.");
    await f.user.type(message(), "Typed draft.");
    text = "Yeah.";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(24_576));
    text = "Send it.";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(24_576));
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Typed draft." }),
      expect.anything(),
    );
  });

  it.each(["raw", "utility"] as const)(
    "applies voice submission enabled during active %s capture",
    async (processing) => {
      let text = "";
      using f = renderDictation({
        client: {
          dictation: {
            transcribe: async (input) => {
              const result = text;
              if (input.final) text = ""; // Native final releases the rolling transcript.
              return result;
            },
          },
        },
      });
      await f.user.selectOptions(
        screen.getByRole("combobox", { name: "Text processing" }),
        processing,
      );
      await f.user.click(mode());
      await f.user.click(message());
      text = "Kept draft";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      await waitFor(() => expect(message().value).toBe("Kept draft"));
      render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
      await f.user.click(screen.getByRole("switch", { name: "Submit message by voice" }));
      await waitFor(listening);
      await f.audio.push(new Float32Array(49_152));
      text = "Send it.";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      await f.audio.push(new Float32Array(49_152));
      await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
      expect(f.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Kept draft" }),
        expect.anything(),
      );
    },
  );

  it("defaults voice sending off and persists its custom phrase through window snapshots", async () => {
    let saved: StoreSnapshot;
    {
      using f = renderDictation();
      render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
      expect(
        screen
          .getByRole("switch", { name: "Submit message by voice" })
          .getAttribute("aria-checked"),
      ).toBe("false");
      await f.user.click(screen.getByRole("switch", { name: "Submit message by voice" }));
      const phrase = screen.getByRole("textbox", { name: "Submit phrase" });
      expect((phrase as HTMLInputElement).value).toBe("send it");
      fireEvent.change(phrase, { target: { value: "over and out" } });
      saved = toSnapshot(f.root) ?? {};
      cleanup();
    }
    using restored = renderDictation({ snapshot: saved });
    render(<SettingsSpeechInputSection store={restored.root.speechInputSettingsStore} />);
    expect(
      screen.getByRole("switch", { name: "Submit message by voice" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Submit phrase" }).value).toBe(
      "over and out",
    );
  });

  it.each(
    [
      "send it",
      "SEND IT!",
      "Send it.",
      "send it?",
      "send it…",
      "  Send it.  ",
      "send it,",
      "“Send it.”",
    ].flatMap((command) =>
      (["raw", "utility"] as const).map((processing) => ({ command, processing })),
    ),
  )(
    "sends only the isolated finalized command $command in $processing, retaining prior speech after blur",
    async ({ command, processing }) => {
      let text = "";
      const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async () => text);
      using f = renderDictation({ client: { dictation: { transcribe } } });
      await f.user.selectOptions(
        screen.getByRole("combobox", { name: "Text processing" }),
        processing,
      );
      await voiceSend(f);
      text = "Previously dictated content.";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      await f.audio.push(new Float32Array(49_152));
      await waitFor(() => expect(message().value).toBe(text));
      text = command;
      await f.user.click(screen.getByRole("heading", { name: "Speech input" }));
      expect(document.activeElement).not.toBe(message());
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      expect(f.prompt).not.toHaveBeenCalled();
      await f.audio.push(new Float32Array(49_152));
      await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
      expect(f.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Previously dictated content." }),
        expect.anything(),
      );
      expect(transcribe.mock.calls.filter(([input]) => input.final)).toHaveLength(2);
      await f.audio.push(new Float32Array(49_152));
      expect(f.prompt).toHaveBeenCalledOnce();
    },
  );

  it.each(["project-session", "project-chat", "cake-chat"] as const)(
    "submits an existing typed draft on the first standalone utterance in %s without a leading wait",
    async (surface) => {
      let text = "";
      using f = renderDictation({
        surface,
        client: { dictation: { transcribe: async () => text } },
      });
      render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
      await f.user.click(screen.getByRole("switch", { name: "Submit message by voice" }));
      await f.user.click(mode());
      const composer = screen.getByRole<HTMLTextAreaElement>("combobox", { name: /^Message/ });
      await f.user.type(composer, "Existing typed draft.");
      listening();
      text = "Send it.";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      expect(f.prompt).not.toHaveBeenCalled();
      await f.audio.push(new Float32Array(24_576)); // six 256 ms quiet frames
      expect(f.prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Existing typed draft." }),
        expect.anything(),
      );
      expect(composer.value).toBe("");
    },
  );

  it("seals prior speech at the native quiet endpoint instead of merging the next standalone command", async () => {
    // Native ASR returns the whole generation, including text before its own quiet endpoints.
    // Only final:true / a new utteranceId releases that rolling transcript.
    let nextSpeech = "";
    let transcript = "";
    let id = "";
    const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async (input) => {
      if (input.utteranceId !== id) {
        id = input.utteranceId;
        transcript = "";
      }
      if (nextSpeech) {
        transcript = [transcript, nextSpeech].filter(Boolean).join(" ");
        nextSpeech = "";
      }
      const result = transcript;
      if (input.final) transcript = "";
      return result;
    });
    using f = renderDictation({ client: { dictation: { transcribe } } });
    await voiceSend(f);
    nextSpeech = "I am testing send it in a sentence.";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(24_576));
    nextSpeech = "Send it.";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(24_576));
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "I am testing send it in a sentence." }),
      expect.anything(),
    );
    expect(transcribe.mock.calls.filter(([input]) => input.final)).toHaveLength(2);
  });

  it("retains the voice-send owner after detected speech blurs before its first decode", async () => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f);
    await f.user.type(message(), "Previously typed content.");
    await f.audio.push(new Float32Array(49_152));
    text = "send it";
    await f.audio.push(new Float32Array(4096).fill(0.1));
    await f.user.click(screen.getByRole("heading", { name: "Speech input" }));
    expect(document.activeElement).not.toBe(message());
    listening();
    await f.audio.push(new Float32Array(12_288).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Previously typed content." }),
      expect.anything(),
    );
  });

  it.each([
    "I want to send it tomorrow",
    "please send it",
    "sent it",
    "send it now",
    "Other speech. Send it.",
    "Send it. Other speech.",
    "Your mother. Send it. Your mother. Send it.",
  ])("keeps nonmatching finalized speech %s as ordinary dictation", async (words) => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f);
    text = words;
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(message().value).toBe(words);
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("never mistakes interim fragments or transport packets for an isolated final utterance", async () => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f);
    text = "send";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    text = "send it";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(16_384)); // short pause is not isolation
    expect(f.prompt).not.toHaveBeenCalled();
    text = "send it tomorrow";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(message().value).toBe(text);
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses consecutive classified quiet, with resumed speech=%s, and records content-free decisions",
    async (resumed) => {
      let text = "";
      const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async () => text);
      using f = renderDictation({ client: { dictation: { transcribe } } });
      await voiceSend(f);
      await f.user.type(message(), "Private existing draft.");
      text = "Send it.";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      await f.audio.push(new Float32Array(20_480)); // 1.28 s is not an endpoint
      expect(f.prompt).not.toHaveBeenCalled();
      expect(transcribe.mock.calls.some(([input]) => input.final)).toBe(false);
      if (resumed) {
        text = "Send it. More private speech.";
        await f.audio.push(new Float32Array(4096).fill(0.1));
        await f.audio.push(new Float32Array(20_480));
        expect(f.prompt).not.toHaveBeenCalled();
        expect(transcribe.mock.calls.some(([input]) => input.final)).toBe(false);
      }
      await f.audio.push(new Float32Array(4096)); // 1.536 s crosses the endpoint
      expect(f.prompt).toHaveBeenCalledTimes(resumed ? 0 : 1);
      expect(f.trace).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "voice-final",
          quietMs: 1536,
          reason: resumed ? "nonmatching" : "command",
        }),
      );
      if (resumed) {
        expect(message().value).toBe("Private existing draft. Send it. More private speech.");
        expect(f.trace).toHaveBeenCalledWith(
          expect.objectContaining({ step: "voice-pause-reset", quietMs: 1280 }),
        );
      } else {
        expect(f.prompt).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Private existing draft." }),
          expect.anything(),
        );
        expect(f.trace).toHaveBeenCalledWith(
          expect.objectContaining({ step: "voice-submit", reason: "requested" }),
        );
      }
      const traces = JSON.stringify(f.trace.mock.calls);
      expect(traces).not.toMatch(/Private|private|Send it|send it/);
      const count = f.trace.mock.calls.length;
      text = "";
      await f.audio.push(new Float32Array(65_536));
      expect(f.trace.mock.calls).toHaveLength(count); // idle silence does not spam the log
    },
  );

  it.each(["Send it tomorrow.", ""])(
    "uses final recognition %j rather than a command-looking interim",
    async (finalText) => {
      let interim = "";
      using f = renderDictation({
        client: { dictation: { transcribe: async ({ final }) => (final ? finalText : interim) } },
      });
      await voiceSend(f);
      await f.user.type(message(), "Existing draft.");
      interim = "Send it.";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      await f.audio.push(new Float32Array(24_576));
      expect(f.prompt).not.toHaveBeenCalled();
      expect(message().value).toBe(["Existing draft.", finalText].filter(Boolean).join(" "));
    },
  );

  it("uses a custom phrase, never the default phrase or utility-cleaned words", async () => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f, "over and out");
    text = "send it";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(f.prompt).not.toHaveBeenCalled();
    text = "OVER AND OUT.";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "send it" }),
      expect.anything(),
    );
  });

  it("supports send it now only when that exact phrase is configured", async () => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f, "send it now");
    text = "Kept speech";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    text = "Send it now.";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Kept speech" }),
      expect.anything(),
    );
  });

  it("never interprets utility cleanup output as a voice command", async () => {
    let text = "";
    using f = renderDictation({
      client: {
        dictation: { transcribe: async () => text },
        workspaces: { postProcessDictation: async () => "send it" },
      },
    });
    await f.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await voiceSend(f);
    text = "Some ordinary words";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(message().value).toBe("send it");
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("leaves ordinary dictation unchanged when voice submission is disabled", async () => {
    let text = "send it";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(message().value).toBe("send it");
    expect(f.prompt).not.toHaveBeenCalled();
    text = "send it again";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(f.prompt).not.toHaveBeenCalled();
    expect(message().value).toBe("send it again");
  });
  it.each(
    (
      ["mute", "stop", "escape", "target", "session", "unmount", "setting", "edit"] as const
    ).flatMap((action) => ["quiet", "final"].map((stage) => ({ action, stage }))),
  )("cancels an isolated command during $stage after $action", async ({ action, stage }) => {
    let text = "";
    const final = deferred<string>();
    const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async (input) =>
      input.final ? final.promise : text,
    );
    using f = renderDictation({ client: { dictation: { transcribe } } });
    await voiceSend(f);
    text = "send it";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(stage === "final" ? 24_576 : 20_480));
    expect(transcribe.mock.calls.some(([input]) => input.final)).toBe(stage === "final");
    if (action === "mute")
      await f.user.click(screen.getByRole("button", { name: "Mute dictation" }));
    if (action === "stop") await f.user.click(mode());
    if (action === "escape") await f.user.keyboard("{Escape}");
    if (action === "target") await f.user.click(trial());
    if (action === "unmount") f.remountComposer();
    if (action === "session") act(() => f.switchProjectSession());
    if (action === "setting")
      await f.user.click(screen.getByRole("switch", { name: "Submit message by voice" }));
    if (action === "edit") await f.user.type(message(), "manual change");
    await act(async () => final.resolve("send it"));
    expect(f.prompt).not.toHaveBeenCalled();
    expect(trial().value).toBe("");
  });

  it("keeps unsupported targets as dictation even when the send phrase is enabled", async () => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f);
    await f.user.click(trial());
    await f.audio.push(new Float32Array(49_152));
    text = "send it";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(trial().value).toBe("send it");
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("removes an empty command without bypassing normal send validation", async () => {
    let text = "";
    using f = renderDictation({ client: { dictation: { transcribe: async () => text } } });
    await voiceSend(f);
    text = "send it";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(message().value).toBe("");
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it.each(["raw", "utility"] as const)(
    "preserves the draft when final recognition fails in %s",
    async (processing) => {
      let text = "";
      let failFinal = false;
      using f = renderDictation({
        client: {
          dictation: {
            transcribe: async (input) => {
              if (input.final && failFinal) throw engineFailure();
              return text;
            },
          },
        },
      });
      await f.user.selectOptions(
        screen.getByRole("combobox", { name: "Text processing" }),
        processing,
      );
      await voiceSend(f);
      text = "Kept speech";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      await f.audio.push(new Float32Array(49_152));
      text = "Send it.";
      await f.audio.push(new Float32Array(16_384).fill(0.1));
      failFinal = true;
      await f.audio.push(new Float32Array(49_152));
      expect(message().value).toBe("Kept speech Send it.");
      expect(f.prompt).not.toHaveBeenCalled();
    },
  );

  it("retains dictated content after submission rejection and never retries the command automatically", async () => {
    let text = "";
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockRejectedValueOnce(new Error("Submission rejected"));
    using f = renderDictation({
      client: { dictation: { transcribe: async () => text }, sessionChats: { prompt } },
    });
    await voiceSend(f);
    text = "Kept speech";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    text = "send it";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    expect(message().value).toBe("Kept speech");
    await f.audio.push(new Float32Array(65_536));
    expect(f.prompt).toHaveBeenCalledOnce();
  });

  it("does not send from recognizer repeats while the ordinary send is busy", async () => {
    let text = "";
    const submitted = deferred<void>();
    using f = renderDictation({
      submissionReady: submitted.promise,
      client: { dictation: { transcribe: async () => text } },
    });
    await voiceSend(f);
    text = "prior text";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    text = "send it";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    await f.audio.push(new Float32Array(65_536).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    expect(f.prompt).toHaveBeenCalledOnce();
    text = "";
    await act(async () => submitted.resolve());
    expect(f.prompt).toHaveBeenCalledOnce();
  });

  it("preserves prior speech when manual Send overlaps pause-finalization cleanup", async () => {
    let text = "";
    const cleaned = deferred<string>();
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      () => cleaned.promise,
    );
    const transcribe = vi.fn<Client["dictation"]["transcribe"]>(async (input) => {
      const result = text;
      if (input.final) text = ""; // native final releases the rolling transcript
      return result;
    });
    using f = renderDictation({
      client: { dictation: { transcribe }, workspaces: { postProcessDictation } },
    });
    await f.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await voiceSend(f);
    text = "previous words";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await f.audio.push(new Float32Array(49_152));
    await waitFor(() => expect(postProcessDictation).toHaveBeenCalledOnce());
    await f.user.keyboard("{Enter}");
    await act(async () => cleaned.resolve("Previous words."));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Previous words." }),
      expect.anything(),
    );
  });

  it("refreshes the vocabulary projection when another window or Cake control publishes a new revision", async () => {
    let words = emptyVocabulary();
    using f = renderDictation({
      client: { dictation: { listVocabulary: async (input) => listVocabulary(words, input) } },
    });
    await screen.findByText("No custom words yet. Add names or company terms you use.");
    act(() => {
      words = changeVocabulary(
        words,
        { action: "add", text: "Binks", aliases: ["Banks"], expectedRevision: 0 },
        "review-agent",
      );
      f.root.dictationStore.applyState({
        ...installedDictationState,
        vocabularyRevision: 1,
        vocabularyCount: 1,
      });
    });
    await screen.findByRole("button", { name: "Edit Binks" });
    expect(f.root.dictationStore.textProcessingMode).toBe("raw");
  });

  it("manages searchable preferred words and aliases through shared settings authority while retaining raw mode", async () => {
    let words = emptyVocabulary();
    const list = vi.fn<Client["dictation"]["listVocabulary"]>(async (input) =>
      listVocabulary(words, input),
    );
    const change = vi.fn<Client["dictation"]["changeVocabulary"]>(async (input) => {
      words = changeVocabulary(words, input, "review-agent");
      return { revision: words.revision };
    });
    using f = renderDictation({
      client: { dictation: { listVocabulary: list, changeVocabulary: change } },
    });
    await screen.findByText("No custom words yet. Add names or company terms you use.");
    await f.user.click(screen.getByRole("button", { name: "Add word" }));
    await f.user.click(screen.getByRole("button", { name: "Save word" }));
    await screen.findByText(/Use 3–80 characters/);
    await f.user.type(screen.getByLabelText("Preferred spelling"), "Binks");
    const aliases = screen.getByLabelText("Aliases / common misrecognitions (optional)");
    await f.user.type(aliases, "binks");
    await f.user.click(screen.getByRole("button", { name: "Save word" }));
    await screen.findByText(
      "Preferred spelling and aliases must be distinct (ignoring case and spacing).",
    );
    await f.user.clear(aliases);
    await f.user.type(aliases, "Banks");
    await f.user.click(screen.getByRole("button", { name: "Save word" }));
    await screen.findByRole("button", { name: "Edit Binks" });
    expect(words.entries).toEqual([{ id: "review-agent", text: "Binks", aliases: ["Banks"] }]);
    expect(screen.getByLabelText<HTMLSelectElement>("Text processing").value).toBe("raw");
    await f.user.type(screen.getByLabelText("Search custom vocabulary"), "banks");
    await screen.findByRole("button", { name: "Edit Binks" });
    await f.user.click(screen.getByRole("button", { name: "Edit Binks" }));
    await f.user.clear(screen.getByLabelText("Preferred spelling"));
    await f.user.type(screen.getByLabelText("Preferred spelling"), "Binx");
    // Another window/tool wins a concurrent edit. The visible draft keeps its old revision.
    words = changeVocabulary(
      words,
      { action: "add", text: "Cake Labs", aliases: [], expectedRevision: 1 },
      "company",
    );
    await f.user.click(screen.getByRole("button", { name: "Save word" }));
    await screen.findByText("Vocabulary changed. Refresh and retry with the current revision.");
    await f.user.click(screen.getByRole("button", { name: "Cancel word edit" }));
    await waitFor(() => expect(f.root.dictationStore.vocabulary.page?.revision).toBe(2));
    await f.user.click(screen.getByRole("button", { name: "Edit Binks" }));
    await f.user.clear(screen.getByLabelText("Preferred spelling"));
    await f.user.type(screen.getByLabelText("Preferred spelling"), "Binx");
    await f.user.click(screen.getByRole("button", { name: "Save word" }));
    await screen.findByRole("button", { name: "Remove Binx" });
    await f.user.click(screen.getByRole("button", { name: "Remove Binx" }));
    await screen.findByText("No matching words or aliases.");
    expect(words.entries).toEqual([{ id: "company", text: "Cake Labs", aliases: [] }]);
    expect(f.root.dictationStore.textProcessingMode).toBe("raw");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }), expect.anything());
  });

  describe.each(["project-session", "project-chat", "cake-chat"] as const)(
    "%s slash-menu dictation boundary",
    (surface) => {
      const composer = () =>
        screen.getByRole<HTMLTextAreaElement>("combobox", { name: /^Message/ });
      const menu = () => screen.queryByRole("listbox", { name: "Slash commands" });

      it.each(["while open", "after dismissal"])(
        "drops pending recognition delivered %s and resumes only a fresh capture",
        async (delivery) => {
          using f = renderDictation({ surface, slashCommands: true });
          await f.user.click(mode());
          await f.user.click(composer());
          await waitFor(listening);
          await f.audio.push(new Float32Array(12_800));
          expect(f.requests).toHaveLength(1);

          fireEvent.change(composer(), { target: { value: "/" } });
          expect(menu()).not.toBeNull();
          expect(document.activeElement).toBe(composer());
          expect(f.root.dictationStore.phase).toBe("paused");
          expect(f.root.dictationStore.activeTargetId).toBeUndefined();
          expect(screen.queryByRole("button", { name: "Mute dictation" })).toBeNull();
          if (delivery === "while open") await f.recognize(0, "Discard this pending speech");
          expect(composer().value).toBe("/");

          // Neither field focus, window focus nor re-enabling the global preference may
          // activate a composer whose menu is open.
          await f.user.click(mode());
          await f.user.click(mode());
          const captures = f.audio.getUserMedia.mock.calls.length;
          await f.user.click(composer());
          fireEvent(window, new Event("focus"));
          expect(f.root.dictationStore.activeTargetId).toBeUndefined();
          expect(f.audio.getUserMedia).toHaveBeenCalledTimes(captures);
          expect(menu()).not.toBeNull();
          expect(composer().value).toBe("/");

          // Escape dismisses the menu rather than muting the user's global preference.
          await f.user.keyboard("{Escape}");
          expect(menu()).toBeNull();
          expect(f.root.dictationStore.enabled).toBe(true);
          expect(f.root.dictationStore.muted).toBe(false);
          await waitFor(listening);
          if (delivery === "after dismissal") await f.recognize(0, "Discard the old generation");
          expect(composer().value).toBe("/");
          await f.audio.push(new Float32Array(12_800));
          await f.recognize(1, "Fresh words");
          expect(composer().value).toBe("/ Fresh words");
          await f.user.type(composer(), " typed too");
          expect(composer().value).toBe("/ Fresh words typed too");
          expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(
            false,
          );
        },
      );

      it.each(["recognition", "cleanup"])(
        "cancels finishing %s when the menu opens, ignoring its late result and deferred send",
        async (stage) => {
          const result = deferred<string>();
          const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
            () => result.promise,
          );
          using f = renderDictation({
            surface,
            slashCommands: true,
            client: { workspaces: { postProcessDictation } },
          });
          if (stage === "cleanup")
            await f.user.selectOptions(
              screen.getByRole("combobox", { name: "Text processing" }),
              "utility",
            );
          await f.user.type(composer(), "Original request");
          await f.user.click(mode());
          await f.user.click(composer());
          await waitFor(listening);
          await f.audio.push(new Float32Array(4096).fill(0.1));
          await f.user.keyboard("{Enter}");
          await waitFor(() => expect(f.requests).toHaveLength(1));
          expect(f.requests[0]!.audio.final).toBe(true);
          if (stage === "cleanup") {
            await f.recognize(0, "Raw words");
            expect(postProcessDictation).toHaveBeenCalledOnce();
          }

          fireEvent.change(composer(), { target: { value: "/" } });
          expect(menu()).not.toBeNull();
          if (stage === "recognition") await f.recognize(0, "Late final words");
          else await act(async () => result.resolve("Late cleaned words"));
          expect(composer().value).toBe("/");
          expect(f.prompt).not.toHaveBeenCalled();
          expect(f.root.dictationStore.activeTargetId).toBeUndefined();
          // Completing the command restores normal typing and dictation without a mode toggle.
          await f.user.keyboard("{Tab}");
          expect(menu()).toBeNull();
          expect(composer().value).toBe("/compact ");
          await waitFor(listening);
          await f.user.type(composer(), "arguments");
          expect(composer().value).toBe("/compact arguments");
        },
      );

      it("cancels microphone preparation if the menu opens before capture is ready", async () => {
        const ready = deferred<void>();
        using f = renderDictation({ surface, slashCommands: true, microphoneReady: ready.promise });
        await f.user.click(mode());
        await f.user.click(composer());
        await waitFor(() => expect(f.audio.getUserMedia).toHaveBeenCalledOnce());
        fireEvent.change(composer(), { target: { value: "/" } });
        expect(menu()).not.toBeNull();
        await act(async () => ready.resolve());
        expect(f.root.dictationStore.phase).toBe("paused");
        expect(f.root.dictationStore.activeTargetId).toBeUndefined();
        expect(f.requests).toHaveLength(0);
        expect(composer().value).toBe("/");
      });
    },
  );

  it("parks convenience focus only while dictation is enabled and unmuted, leaving capture to explicit Tab", async () => {
    using f = renderDictation({ composerFocusEnabled: true });
    expect(document.activeElement).toBe(message());
    await f.user.click(mode());
    f.requestFocus();
    const anchor = message().parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(anchor));
    expect(f.audio.getUserMedia).not.toHaveBeenCalled();
    expect(f.root.dictationStore.activeTargetId).toBeUndefined();

    await f.user.tab();
    expect(document.activeElement).toBe(message());
    await waitFor(() => expect(f.audio.getUserMedia).toHaveBeenCalledOnce());
    await f.user.type(message(), "Explicit input");
    expect(message().value).toBe("Explicit input");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false);
    await f.user.click(screen.getByRole("button", { name: "Mute dictation" }));
    expect(f.root.dictationStore.muted).toBe(true);
    await f.user.click(screen.getByLabelText("Use an existing Core ML Parakeet model folder"));
    f.requestFocus();
    await waitFor(() => expect(document.activeElement).toBe(message()));
    expect(f.audio.getUserMedia).toHaveBeenCalledOnce();

    await f.user.click(mode());
    f.requestFocus();
    await waitFor(() => expect(document.activeElement).toBe(message()));
    expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "focuses a queued message for explicit editing with dictation enabled=%s, without changing passive focus policy",
    async (dictationEnabled) => {
      using f = renderDictation({ composerFocusEnabled: true });
      if (dictationEnabled) await f.user.click(mode());
      f.publish({
        _tag: "PartUpdated",
        sessionId: "dictation-session",
        part: {
          id: "queued-edit",
          kind: "text",
          role: "user",
          text: "Edit this queued request",
          status: "complete",
          deliveryState: "queued",
          queuedInput: {
            itemId: "20000000-0000-4000-8000-000000000001",
            text: "Edit this queued request",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
        },
      });
      await f.user.click(
        screen.getByRole("button", {
          name: "Edit queued prompt: Edit this queued request",
        }),
      );
      const popup = screen.getByRole("dialog", { name: "Queued message" });
      const editor = within(popup).getByRole<HTMLTextAreaElement>("textbox");
      await waitFor(() => expect(document.activeElement).toBe(editor));
      expect(editor.value).toBe("Edit this queued request");
      expect(screen.getByRole("list", { name: "Queued prompts" })).toBeDefined();
      await f.user.type(editor, " revised");
      expect(editor.value).toBe("Edit this queued request revised");
      expect(within(popup).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(
        false,
      );
      expect(message().value).toBe("");
      await f.user.click(within(popup).getByRole("button", { name: "Cancel" }));
      await f.user.keyboard("{Escape}");
      expect(mode().getAttribute("aria-checked")).toBe(String(dictationEnabled));
      expect(
        screen
          .getByRole("switch", {
            name: "Prevent automatic refocusing while dictating",
          })
          .getAttribute("aria-checked"),
      ).toBe("true");
      await f.user.click(screen.getByLabelText("Use an existing Core ML Parakeet model folder"));
      f.requestFocus();
      await waitFor(() =>
        expect(document.activeElement).toBe(dictationEnabled ? message().parentElement : message()),
      );
    },
  );

  it("applies the dictation refocus setting immediately to existing composer focus requests", async () => {
    using f = renderDictation({ composerFocusEnabled: true });
    const preventRefocus = screen.getByRole("switch", {
      name: "Prevent automatic refocusing while dictating",
    });
    expect(preventRefocus.getAttribute("aria-checked")).toBe("true");
    await f.user.click(mode());
    f.requestFocus();
    await waitFor(() => expect(document.activeElement).toBe(message().parentElement));

    await f.user.click(preventRefocus);
    expect(preventRefocus.getAttribute("aria-checked")).toBe("false");
    f.requestFocus();
    await waitFor(() => expect(document.activeElement).toBe(message()));
    await f.user.type(message(), "Normal focus");
    expect(message().value).toBe("Normal focus");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false);

    await f.user.click(preventRefocus);
    f.requestFocus();
    await waitFor(() => expect(document.activeElement).toBe(message().parentElement));
    expect(preventRefocus.getAttribute("aria-checked")).toBe("true");
  });

  it.each([true, false])(
    "applies prevent-refocus=%s after a silent asynchronous send",
    async (preventRefocus) => {
      const submission = deferred<void>();
      using f = renderDictation({
        composerFocusEnabled: true,
        submissionReady: submission.promise,
      });
      await f.user.click(mode());
      f.requestFocus();
      await waitFor(() => expect(document.activeElement).toBe(message().parentElement));
      await f.user.tab();
      await waitFor(() => expect(f.audio.getUserMedia).toHaveBeenCalledOnce());
      if (!preventRefocus)
        await f.user.click(
          screen.getByRole("switch", {
            name: "Prevent automatic refocusing while dictating",
          }),
        );
      await f.user.type(message(), "Send this request");
      await f.user.keyboard("{Enter}");
      await waitFor(() => expect(f.requests).toHaveLength(1));
      await f.recognize(0, "");
      await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
      await act(async () => submission.resolve());
      await waitFor(() =>
        expect(document.activeElement).toBe(preventRefocus ? message().parentElement : message()),
      );
      expect(message().value).toBe("");
      if (preventRefocus) {
        // A typed-only send did not capture speech in this focus period.
        expect(f.root.dictationStore.phase).toBe("paused");
        await f.user.tab();
      }
      await waitFor(listening);
      await f.audio.push(new Float32Array(12_800));
      await f.recognize(1, "Next request");
      expect(message().value).toBe("Next request");
      expect(document.activeElement).toBe(message());
    },
  );

  it.each([false, true])(
    "serializes rapid Enter escalation across admission and a lane-projection gap; cancellation during steering=%s",
    async (cancelDuringSteering) => {
      const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
      const admission = deferred<typeof turnId>();
      const steering = deferred<void>();
      const newest = {
        id: "newest-queued",
        kind: "text" as const,
        role: "user" as const,
        text: "Same text",
        status: "complete" as const,
        deliveryState: "queued" as const,
        queuedInput: {
          itemId: "20000000-0000-4000-8000-000000000002",
          turnId,
          text: "Same text",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
      };
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(() => admission.promise);
      const steerQueuedMessage = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => {
        await steering.promise;
        f.publish({ _tag: "PartRemoved", sessionId: "dictation-session", partId: newest.id });
        f.publish({
          _tag: "PartUpdated",
          sessionId: "dictation-session",
          part: {
            ...newest,
            id: "newest-steering",
            deliveryState: "steering",
          },
        });
        return { steering: ["Same text"], followUp: ["Same text"] };
      });
      const sendQueuedMessageNow = vi.fn<Client["sessionChats"]["sendQueuedMessageNow"]>(
        async () => {
          f.publish({
            _tag: "PartRemoved",
            sessionId: "dictation-session",
            partId: "newest-steering",
          });
          return { steering: [], followUp: ["Same text"] };
        },
      );
      using f = renderDictation({
        composerFocusEnabled: true,
        client: {
          sessionChats: { prompt, steerQueuedMessage, sendQueuedMessageNow },
        },
      });
      f.publish({ _tag: "StreamingChanged", sessionId: "dictation-session", streaming: true });
      f.publish({
        _tag: "PartUpdated",
        sessionId: "dictation-session",
        part: {
          ...newest,
          id: "older",
          queuedInput: {
            ...newest.queuedInput,
            itemId: "20000000-0000-4000-8000-000000000003",
            turnId: "10000000-0000-4000-8000-000000000003",
          },
        },
      });
      await f.user.click(mode());
      await f.user.type(message(), "Same text");
      await f.user.keyboard("{Enter}");
      await waitFor(() => expect(f.requests).toHaveLength(1));
      await f.recognize(0, "");
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      await f.user.keyboard("{Enter}{Enter}");
      expect(steerQueuedMessage).not.toHaveBeenCalled();
      f.publish({ _tag: "PartUpdated", sessionId: "dictation-session", part: newest });
      await act(async () => admission.resolve(turnId));
      await waitFor(() => expect(steerQueuedMessage).toHaveBeenCalledOnce());
      expect(steerQueuedMessage.mock.calls[0]?.[0]).toEqual({
        sessionId: "dictation-session",
        partId: newest.id,
      });
      expect(sendQueuedMessageNow).not.toHaveBeenCalled();
      if (cancelDuringSteering) await f.user.keyboard("{ArrowDown}");
      await act(async () => steering.resolve());
      if (cancelDuringSteering) {
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Cancel steering: Same text" })).toBeTruthy(),
        );
        await f.user.keyboard("{Enter}");
        expect(sendQueuedMessageNow).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(sendQueuedMessageNow).toHaveBeenCalledOnce());
        expect(sendQueuedMessageNow.mock.calls[0]?.[0]).toEqual({
          sessionId: "dictation-session",
          partId: "newest-steering",
        });
      }
      expect(
        screen.getAllByRole("button", { name: "View queued message: Same text" }),
      ).toHaveLength(cancelDuringSteering ? 2 : 1);
      expect(prompt).toHaveBeenCalledOnce();
    },
  );

  it.each(["other key", "pointer", "focus"] as const)(
    "cancels pending admission continuation on %s and never re-arms on completion",
    async (action) => {
      const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
      const admission = deferred<typeof turnId>();
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(() => admission.promise);
      const steerQueuedMessage = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => ({
        steering: [],
        followUp: ["Delayed"],
      }));
      using f = renderDictation({
        composerFocusEnabled: true,
        client: { sessionChats: { prompt, steerQueuedMessage } },
      });
      await f.user.click(mode());
      await f.user.type(message(), "Delayed");
      await f.user.keyboard("{Enter}");
      await waitFor(() => expect(f.requests).toHaveLength(1));
      await f.recognize(0, "");
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      await f.user.keyboard("{Enter}");
      if (action === "other key") await f.user.keyboard("{ArrowDown}");
      else if (action === "pointer")
        await f.user.click(screen.getByLabelText("Use an existing Core ML Parakeet model folder"));
      else act(() => trial().focus());
      const focused = document.activeElement;
      f.publish({
        _tag: "PartUpdated",
        sessionId: "dictation-session",
        part: {
          id: "delayed-queued",
          kind: "text",
          role: "user",
          text: "Delayed",
          status: "complete",
          deliveryState: "queued",
          queuedInput: {
            itemId: "20000000-0000-4000-8000-000000000001",
            turnId,
            text: "Delayed",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
        },
      });
      await act(async () => admission.resolve(turnId));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "View queued message: Delayed" })).toBeTruthy(),
      );
      if (action !== "other key") expect(document.activeElement).toBe(focused);
      f.requestFocus();
      await waitFor(() => expect(document.activeElement).toBe(message().parentElement));
      await f.user.keyboard("{Enter}");
      expect(steerQueuedMessage).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledOnce();
    },
  );

  it("empty Enter keeps listening without reopening capture, including pending noise-only recognition", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    await f.user.click(message());
    const preparations = f.prepare.mock.calls.length;
    await f.user.keyboard("{Enter}{Enter}");
    listening();
    expect(f.requests).toHaveLength(0);
    await f.audio.push(new Float32Array(12_800));
    await f.user.keyboard("{Enter}");
    listening();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.audio.final).toBe(false);
    await f.recognize(0, "");
    expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
    expect(f.audio.tracks[0]!.stop).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledTimes(preparations);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    expect(message().value).toBe("");
    // Detected speech awaiting its first words must still be finalized from an empty field.
    await f.audio.push(new Float32Array(4096).fill(0.1));
    await f.user.keyboard("{Enter}");
    expect(f.requests[1]!.audio.final).toBe(true);
    await f.recognize(1, "Spoken request");
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
  });

  it("field changes discard pending detection without cancelling the warm recognition request", async () => {
    const detection = deferred<boolean>();
    const detectSpeech = vi
      .fn<Client["dictation"]["detectSpeech"]>()
      .mockImplementationOnce(() => detection.promise)
      .mockImplementation(detectFixtureSpeech);
    using f = renderDictation({ client: { dictation: { detectSpeech } } });
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(4096).fill(0.1));
    await waitFor(() => expect(detectSpeech).toHaveBeenCalledOnce());
    const signal = detectSpeech.mock.calls[0]![1]?.signal;
    await f.user.click(trial());
    expect(signal?.aborted).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    await act(async () => detection.resolve(true));
    listening();
    expect(message().value).toBe("");
    expect(trial().value).toBe("");
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    await f.recognize(0, "Fresh field speech");
    expect(trial().value).toBe("Fresh field speech");
    expect(message().value).toBe("");
  });

  it("shared speech controls reach dictation detection and recognition, freeze per capture and exclude voice-only policy", async () => {
    const detect = vi.fn<Client["dictation"]["detectSpeech"]>(
      async (input) => 0.7 >= (input.thresholds?.start ?? 0.6),
    );
    using f = renderDictation({ client: { dictation: { detectSpeech: detect } } });
    render(<SettingsSpeechInputSection store={f.root.speechInputSettingsStore} />);
    await f.user.click(screen.getByRole("button", { name: "Advanced speech input" }));
    const sensitivity = screen.getByRole("slider", { name: "Speech detection sensitivity" });
    fireEvent.change(sensitivity, { target: { value: "0.85" } });
    fireEvent.change(screen.getByRole("slider", { name: "Speech continuation threshold" }), {
      target: { value: "0.5" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Minimum speech duration" }), {
      target: { value: "1000" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Audio lookback" }), {
      target: { value: "300" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Maximum utterance length" }), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Pause before automatic send" }), {
      target: { value: "1" },
    });
    await f.user.click(screen.getByRole("switch", { name: "Allow short interruption commands" }));
    for (const label of [
      "Speech detection sensitivity",
      "Speech continuation threshold",
      "Minimum speech duration",
      "Audio lookback",
      "Maximum utterance length",
    ]) {
      const slider = screen.getByRole("slider", { name: label });
      expect(
        document.getElementById(slider.getAttribute("aria-describedby")!)?.textContent,
      ).toContain("Dictation + voice mode");
    }
    for (const label of [
      "Pause before automatic send",
      "Countdown display delay",
      "Words required to interrupt",
      "Interruption recognition window",
    ]) {
      const slider = screen.getByRole("slider", { name: label });
      expect(
        document.getElementById(slider.getAttribute("aria-describedby")!)?.textContent,
      ).toContain("Voice mode only");
    }
    await f.user.click(mode());
    await f.user.click(message());
    listening();
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    const shared = {
      thresholds: { start: 0.85, continuation: 0.5 },
      minimumSpeechMs: 1000,
      prerollMs: 300,
      maximumUtteranceSeconds: 5,
    };
    expect(f.requests[0]!.audio.settings).toEqual(shared);
    await waitFor(() => expect(detect).toHaveBeenCalled());
    expect(detect.mock.calls[0]![0].thresholds).toEqual(shared.thresholds);
    await f.recognize(0, "");
    fireEvent.change(sensitivity, { target: { value: "0.6" } });
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    expect(f.requests[1]!.audio.settings).toEqual(shared);
    await f.recognize(1, "");
    await f.user.click(trial());
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    expect(f.requests[2]!.audio.settings).toEqual({
      ...shared,
      thresholds: { start: 0.6, continuation: 0.5 },
    });
    await f.recognize(2, "Recognized speech");
    expect(trial().value).toBe("Recognized speech");
    await f.audio.push(new Float32Array(48_000));
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("revises recognition across a thinking pause and drains final words before Enter without utility work", async () => {
    let text = "Is this a question that I should?";
    const final = deferred<string>();
    const transcribe = vi.fn<Client["dictation"]["transcribe"]>((input) =>
      input.final ? final.promise : Promise.resolve(text),
    );
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>();
    using f = renderDictation({
      client: { dictation: { transcribe }, workspaces: { postProcessDictation } },
    });
    expect(screen.getByRole("combobox", { name: "Text processing" })).toHaveProperty(
      "value",
      "raw",
    );
    await f.user.type(message(), "Typed:");
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await waitFor(() => expect(message().value).toBe("Typed: " + text));
    for (let i = 0; i < 16; i++) await f.audio.push(new Float32Array(4096));
    expect(message().value).toBe("Typed: " + text);
    text = "Is this a question that I should be asking?";
    await f.audio.push(new Float32Array(16_384).fill(0.1));
    await waitFor(() => expect(message().value).toBe("Typed: " + text));
    expect(new Set(transcribe.mock.calls.map(([input]) => input.utteranceId)).size).toBe(1);
    await f.user.keyboard("{Enter}");
    await waitFor(() => expect(transcribe.mock.calls.at(-1)?.[0].final).toBe(true));
    expect(f.prompt).not.toHaveBeenCalled();
    await act(async () => final.resolve(text + " Please explain."));
    await waitFor(() =>
      expect(f.prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Typed: " + text + " Please explain." }),
        expect.any(Object),
      ),
    );
    expect(postProcessDictation).not.toHaveBeenCalled();
  });
  it("persists dictation preferences, restoring capture only on focus", async () => {
    let saved: StoreSnapshot | undefined;
    {
      const save = vi.fn<Client["windowState"]["save"]>(async () => undefined);
      using fixture = renderDictation({ client: { windowState: { save } } });
      using persistence = new WindowStatePersistence(fixture.client, (error) => {
        throw error;
      });
      persistence.observe(fixture.root);
      await fixture.user.click(mode());
      await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
      await screen.findByRole("option", { name: "USB microphone" });
      await fixture.user.selectOptions(screen.getByLabelText("Microphone"), "usb-mic");
      await fixture.user.click(trial());
      listening();
      await fixture.user.keyboard("{Escape}");
      expect(mode().getAttribute("aria-checked")).toBe("true");
      await persistence.flush();
      saved = toSnapshot(fixture.root);
      expect(save).toHaveBeenLastCalledWith(saved);
      expect(saved?.children?.dictationStore).toEqual({
        state: {
          enabled: true,
          deviceId: "usb-mic",
          textProcessingMode: "raw",
          preventAutomaticRefocus: true,
        },
      });
    }
    {
      using fixture = renderDictation({ snapshot: saved });
      expect(mode().getAttribute("aria-checked")).toBe("true");
      await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
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

  it("shows the composer indicator while its field listens, including after a silent blur", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    const indicator = () =>
      document.querySelector('[data-slot="composer-dictation"] [data-slot="dictation-indicator"]');
    expect(indicator()).toBeNull();
    await fixture.user.click(message());
    listening();
    expect(indicator()).not.toBeNull();
    await fixture.user.click(document.body);
    expect(fixture.root.dictationStore.phase).toBe("listening");
    expect(indicator()).not.toBeNull();
    await fixture.user.click(message());
    listening();
    expect(indicator()).not.toBeNull();
    // Keyboard focus into the field's own control keeps it, muted or not; leaving it hides it.
    act(() => screen.getByRole<HTMLButtonElement>("button", { name: "Mute dictation" }).focus());
    expect(indicator()).not.toBeNull();
    await fixture.user.keyboard("{Enter}");
    expect(document.activeElement).toBe(message());
    act(() => screen.getByRole<HTMLButtonElement>("button", { name: "Unmute dictation" }).focus());
    expect(indicator()).not.toBeNull();
    await fixture.user.click(document.body);
    expect(indicator()).toBeNull();
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
    const control = screen.getByRole("button", { name: "Mute dictation" });
    const status = screen.getByText("Preparing dictation… Wait to speak", { selector: "span" });
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.querySelector('[role="status"]')).not.toBeNull();
    expect(control.closest('[data-slot="composer-dictation"]')).not.toBeNull();
    expect(fixture.audio.getUserMedia).not.toHaveBeenCalled();
    await act(async () => model.resolve());
    // Preparation is idempotent; each focus generation may re-prepare after a voice handoff.
    expect(fixture.prepare).toHaveBeenCalled();
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    expect(screen.queryByText("Listening")).toBeNull();
    expect(control.getAttribute("aria-busy")).toBe("true");
    await act(async () => microphone.resolve());
    listening();
    expect(control.getAttribute("aria-busy")).toBe("false");
    expect(control.querySelector('[data-slot="voice-meter"]')).not.toBeNull();
    expect(control.closest('[data-slot="composer-dictation"]')).not.toBeNull();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Latest field receives speech");
    expect(message().value).toBe("Latest field receives speech");
    expect(trial().value).toBe("");
  });

  it("a click's select event during microphone opening keeps the open and listens at the new caret", async () => {
    const permission = deferred<void>();
    using fixture = renderDictation({ permission: permission.promise });
    await fixture.user.type(message(), "Hello world");
    await fixture.user.click(mode());
    act(() => message().blur());
    await fixture.user.click(message());
    expect(fixture.root.dictationStore.phase).toBe("preparing");
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    act(() => {
      message().setSelectionRange(5, 5);
      fireEvent.select(message());
    });
    expect(fixture.root.dictationStore.phase).toBe("preparing");
    await act(async () => permission.resolve());
    await waitFor(listening);
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    expect(fixture.audio.tracks[0]!.stop).not.toHaveBeenCalled();
    await act(async () => {});
    expect(fixture.trace.mock.calls.map(([entry]) => entry.step)).not.toContain("cancelled");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "there");
    expect(message().value).toBe("Hello there world");
  });

  it("continues dictation preparation when loading replaces an autofocused drop-down composer", async () => {
    const model = deferred<void>();
    using fixture = renderDictation({
      modelReady: model.promise,
      composerFocusEnabled: true,
      parkComposerFocusWhileDictating: false,
      snapshot: {
        state: {},
        children: { dictationStore: { state: { enabled: true }, children: {} } },
      },
    });
    await waitFor(() => expect(fixture.prepare).toHaveBeenCalled());
    fixture.remountComposer();
    await act(async () => model.resolve());
    await waitFor(listening);
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Speech reaches the replacement composer");
    expect(message().value).toBe("Speech reaches the replacement composer");
    expect(mode().getAttribute("aria-checked")).toBe("true");
  });

  describe("restored enablement on a fresh launch", () => {
    const restored = {
      state: {},
      children: { dictationStore: { state: { enabled: true }, children: {} } },
    };
    /** Mounts like a restarted window, then preloads as the desktop entry point does. */
    const launch = (modelReady: Promise<void>, snapshot: StoreSnapshot = restored) => {
      const f = renderDictation({
        modelReady,
        snapshot,
        state: { ...installedDictationState, status: "installed" },
      });
      act(() => f.root.dictationStore.preloadOnLaunch());
      return f;
    };
    const control = () => screen.getByRole("button", { name: /dictation$/ });
    /** Desktop-log entries sent so far, after fire-and-forget delivery. */
    const logged = async (f: ReturnType<typeof renderDictation>) => {
      await act(async () => {});
      return f.trace.mock.calls.map(([entry]) => entry);
    };
    /** The click's own startup attempt, apart from the background preload's lines. */
    const clickAttempt = async (f: ReturnType<typeof renderDictation>) => {
      const lines = await logged(f);
      const attempt = lines.find(({ step }) => step === "start-requested")!.attempt;
      return lines.filter((line) => line.attempt === attempt);
    };

    it("preloads the model in the background without a field or the microphone", async () => {
      const model = deferred<void>();
      using f = launch(model.promise);
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.audio.getUserMedia).not.toHaveBeenCalled();
      expect(f.root.dictationStore.phase).toBe("paused");
      expect(document.querySelector('[data-slot="dictation-indicator"]')).toBeNull();
      await act(async () => model.resolve());
      const lines = await logged(f);
      expect(lines).toEqual([
        expect.objectContaining({ step: "model-load-requested", reason: "launch" }),
        expect.objectContaining({ step: "model-load-finished", elapsedMs: expect.any(Number) }),
      ]);
      expect(lines[1]!.attempt).toBe(lines[0]!.attempt);
    });

    it("does not preload when dictation is disabled", async () => {
      using f = launch(Promise.resolve(), { state: {}, children: {} });
      await act(async () => {});
      expect(f.prepare).not.toHaveBeenCalled();
      expect(await logged(f)).toEqual([]);
    });

    it("a click during the preload joins it and the same field listens when it finishes", async () => {
      const model = deferred<void>();
      using f = launch(model.promise);
      await f.user.click(message());
      expect(control().getAttribute("aria-busy")).toBe("true");
      expect(f.audio.getUserMedia).not.toHaveBeenCalled();
      await act(async () => model.resolve());
      await waitFor(listening);
      // One load: the click waited for the preload instead of starting or restarting another.
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(message());
      expect(control().getAttribute("aria-busy")).toBe("false");
      expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
      await f.audio.push(new Float32Array(12_800));
      await f.recognize(0, "Ready after first load");
      expect(message().value).toBe("Ready after first load");
      const lines = await clickAttempt(f);
      expect(lines.map(({ step }) => step)).toEqual([
        "start-requested",
        "model-load-requested",
        "engine-ready",
        "model-load-finished",
        "mic-open-requested",
        "mic-opened",
        "listening",
      ]);
      // Durations and reasons, never speech or draft text.
      expect(lines[0]).toMatchObject({ reason: "focus", field: expect.any(String) });
      expect(lines[1]).toMatchObject({ reason: "joined" });
      expect(lines.find(({ step }) => step === "model-load-finished")).toMatchObject({
        elapsedMs: expect.any(Number),
      });
      expect(JSON.stringify(await logged(f))).not.toContain("Ready after first load");
    });

    it("logs an ignored re-click while loading, with whether an attempt is still alive", async () => {
      const model = deferred<void>();
      using f = launch(model.promise);
      await f.user.click(message());
      act(() => fireEvent(window, new Event("focus")));
      const ignored = (await clickAttempt(f)).filter(({ step }) => step === "focus-ignored");
      expect(ignored).toEqual([
        expect.objectContaining({ reason: "already-preparing", field: expect.any(String) }),
      ]);
      await act(async () => model.resolve());
      await waitFor(listening);
    });

    it("a load failure during the click offers Retry instead of an endless spinner", async () => {
      const model = deferred<void>();
      using f = launch(model.promise);
      await f.user.click(message());
      await act(async () => model.reject(new Error("Model failed to load")));
      const retry = await screen.findByRole("button", { name: "Retry dictation" });
      expect(retry.getAttribute("aria-busy")).toBe("false");
      expect(f.root.dictationStore.phase).toBe("error");
      expect(f.audio.getUserMedia).not.toHaveBeenCalled();
      expect((await clickAttempt(f)).at(-1)).toMatchObject({
        step: "failed",
        stage: "startup",
        code: "unknown",
      });
      expect(JSON.stringify(await logged(f))).not.toContain("Model failed to load");
    });

    it("a preload failure stays silent until the next click, which offers Retry", async () => {
      const model = deferred<void>();
      using f = launch(model.promise);
      await act(async () => model.reject(new Error("Model failed to load")));
      expect(f.root.dictationStore.phase).toBe("paused");
      expect(f.root.dictationStore.error).toBeUndefined();
      expect(screen.queryByText("Model failed to load")).toBeNull();
      expect((await logged(f)).at(-1)).toMatchObject({ step: "failed", stage: "preload" });
      await f.user.click(message());
      const retry = await screen.findByRole("button", { name: "Retry dictation" });
      expect(f.root.dictationStore.label).toBe("Model failed to load");
      expect(f.prepare).toHaveBeenCalledOnce();
      f.prepare.mockImplementation(async () => {
        f.root.dictationStore.applyState({ ...installedDictationState, status: "ready" });
      });
      await f.user.click(retry);
      await waitFor(listening);
      expect(f.prepare).toHaveBeenCalledTimes(2);
    });

    it("blurring during the first load keeps the attempt, which listens once the model loads", async () => {
      const model = deferred<void>();
      using f = launch(model.promise);
      await f.user.click(message());
      await f.user.click(document.body);
      expect(control().getAttribute("aria-busy")).toBe("true");
      await act(async () => model.resolve());
      await waitFor(listening);
      expect(document.activeElement).not.toBe(message());
      expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
      await f.audio.push(new Float32Array(12_800));
      await f.recognize(0, "Loaded while unfocused");
      expect(message().value).toBe("Loaded while unfocused");
      const lines = await clickAttempt(f);
      expect(lines.map(({ step }) => step)).not.toContain("cancelled");
      expect(lines.at(-1)).toMatchObject({ step: "listening" });
    });
  });

  it("turning dictation on preloads the model, and a click during that load joins it", async () => {
    const model = deferred<void>();
    using f = renderDictation({
      modelReady: model.promise,
      state: { ...installedDictationState, status: "installed" },
    });
    await f.user.click(mode());
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.audio.getUserMedia).not.toHaveBeenCalled();
    await f.user.click(message());
    expect(screen.getByRole("button", { name: "Mute dictation" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    await act(async () => model.resolve());
    await waitFor(listening);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
    await act(async () => {});
    const lines = f.trace.mock.calls.map(([entry]) => entry);
    const preload = lines.find(({ reason }) => reason === "enable")!;
    expect(preload).toMatchObject({ step: "model-load-requested" });
    expect(lines).toContainEqual(
      expect.objectContaining({
        attempt: preload.attempt,
        step: "model-load-finished",
        elapsedMs: expect.any(Number),
      }),
    );
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
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    expect(fixture.audio.processors).toHaveLength(1);
    expect(fixture.audio.tracks[0]!.stop).not.toHaveBeenCalled();
    await fixture.recognize(2, "Old unfinished tail");
    expect(message().value).toBe("Keep this sentence");
    expect(trial().value).toBe("");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(3, "New field");
    expect(trial().value).toBe("New field");
    expect(fixture.requests[3]!.audio.utteranceId).not.toBe(fixture.requests[0]!.audio.utteranceId);
  });

  it.each(["silence", "empty transcription", "pending detection", "preparing"])(
    "keeps listening on blur after %s and writes later speech to the dictating field",
    async (kind) => {
      const ready = deferred<void>();
      const detection = deferred<boolean>();
      using fixture = renderDictation({
        microphoneReady: kind === "preparing" ? ready.promise : undefined,
        client: {
          dictation: {
            detectSpeech:
              kind === "pending detection" ? () => detection.promise : async () => false,
          },
        },
      });
      await fixture.user.click(mode());
      await fixture.user.click(message());
      if (kind === "preparing") {
        await waitFor(() => expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce());
      } else {
        await fixture.audio.push(new Float32Array(12_800));
        if (kind === "empty transcription") await fixture.recognize(0, " \n ");
      }
      await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
      expect(document.activeElement).not.toBe(message());
      await act(async () => {
        ready.resolve();
        detection.resolve(true);
      });
      await waitFor(listening);
      if (kind === "preparing" || kind === "empty transcription")
        await fixture.audio.push(new Float32Array(12_800).fill(0.1));
      await fixture.recognize(fixture.requests.length - 1, "Speech after blur");
      expect(message().value).toBe("Speech after blur");
      expect(fixture.root.dictationStore.phase).toBe("listening");
      expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
      expect(fixture.audio.tracks[0]!.stop).not.toHaveBeenCalled();
    },
  );

  it("writes speech to the dictating field, never a plain input that took focus before speech", async () => {
    using fixture = renderDictation();
    render(<input aria-label="Plain field" />);
    const plain = screen.getByRole<HTMLInputElement>("textbox", { name: "Plain field" });
    await fixture.user.type(message(), "Draft");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    listening();
    await fixture.user.click(plain);
    await fixture.user.keyboard("typed");
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    await fixture.recognize(0, "spoken");
    expect(plain.value).toBe("typed");
    expect(message().value).toBe("Draft spoken");
    expect(document.activeElement).toBe(plain);
    listening();
  });

  it("moves dictation to the next focused field without late predecessor results; blur keeps it there", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    await fixture.recognize(0, "First speech");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.user.click(trial());
    // A late blur from the predecessor must not stop the new target.
    fireEvent.blur(message());
    listening();
    await fixture.recognize(1, "Old tail");
    await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    listening();
    expect(trial().value).toBe("");
    expect(message().value).toBe("First speech");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(2, "Trial speech");
    expect(trial().value).toBe("Trial speech");
    expect(message().value).toBe("First speech");
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
  });

  it.each(["detected speech", "transcription"])(
    "keeps %s across blur and continues the same insertion on refocus",
    async (kind) => {
      using fixture = renderDictation();
      await fixture.user.type(message(), "Existing draft");
      await fixture.user.click(mode());
      await fixture.user.click(message());
      listening();
      await fixture.audio.push(new Float32Array(12_800).fill(kind === "detected speech" ? 0.1 : 0));
      if (kind === "transcription") await fixture.recognize(0, "Spoken");
      await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
      if (kind === "detected speech") await fixture.recognize(0, "Spoken");
      expect(message().value).toBe("Existing draft Spoken");
      expect(document.activeElement).not.toBe(message());
      listening();
      expect(fixture.audio.tracks[0]!.stop).not.toHaveBeenCalled();

      // Keyboard navigation away from the indicator must also retain the writing target.
      act(() => screen.getByRole<HTMLButtonElement>("button", { name: "Mute dictation" }).focus());
      await fixture.user.tab();
      await fixture.audio.push(new Float32Array(12_800));
      await fixture.recognize(1, "Spoken revision");
      expect(message().value).toBe("Existing draft Spoken revision");
      // Returning to the field is not a restart: no audio is dropped and no new device opens.
      await act(async () => message().focus());
      listening();
      await fixture.audio.push(new Float32Array(12_800));
      await fixture.recognize(2, "Spoken revision continued");
      expect(message().value).toBe("Existing draft Spoken revision continued");
      expect(fixture.requests[2]!.audio.utteranceId).toBe(fixture.requests[0]!.audio.utteranceId);
      expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    },
  );

  it("releases an unmounted target but does not release its explicitly focused successor", async () => {
    using fixture = renderDictation();
    await fixture.user.type(message(), "Retained draft");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800));
    fixture.remountComposer();
    await fixture.recognize(0, "Late unmounted speech");
    expect(message().value).toBe("Retained draft");
    expect(fixture.root.dictationStore.activeTargetId).toBeUndefined();

    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.user.type(trial(), "Other draft");
    fixture.remountComposer();
    listening();
    await fixture.recognize(1, "Late predecessor speech");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(2, "Fresh speech");
    expect(message().value).toBe("Retained draft");
    expect(trial().value).toBe("Other draft Fresh speech");
  });

  it("ends speech ownership on session switch and ignores its delayed transcription", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    await fixture.recognize(0, "Original session draft");
    await fixture.audio.push(new Float32Array(12_800));
    act(() => fixture.switchProjectSession());
    expect(fixture.root.dictationStore.activeTargetId).toBeUndefined();
    await fixture.user.click(message());
    await fixture.recognize(1, "Late previous session tail");
    expect(message().value).toBe("");
    await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    listening();
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(2, "New session speech");
    expect(message().value).toBe("New session speech");
  });

  it.each(["Keep editing", "Submit", "Discard"])(
    "drains pending annotation transcription before %s without losing the draft",
    async (choice) => {
      using fixture = renderDictation();
      await fixture.user.click(mode());
      const close = vi.fn();
      const save = vi.fn();
      const view = render(
        <StoreProvider store={fixture.root.dictationStore}>
          <AnnotationDraftPopover anchor={document.body} onSave={save} onClose={close} />
        </StoreProvider>,
      );
      try {
        const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Annotation comment",
        });
        await fixture.user.type(input, "Typed prefix");
        await fixture.audio.push(new Float32Array(12_800).fill(0.1));
        await fixture.audio.push(new Float32Array(3200));
        await fixture.user.click(message());
        expect(screen.getByRole("alertdialog")).toBeDefined();
        expect(screen.getByRole<HTMLButtonElement>("button", { name: "Submit" }).disabled).toBe(
          true,
        );
        expect(input.isConnected).toBe(true);
        expect(close).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        await fixture.recognize(0, "Beginning");
        await waitFor(() => expect(fixture.requests).toHaveLength(2));
        await fixture.recognize(1, "Beginning and final words");
        await waitFor(() =>
          expect(screen.getByRole<HTMLButtonElement>("button", { name: choice }).disabled).toBe(
            false,
          ),
        );
        expect(input.value).toBe("Typed prefix Beginning and final words");
        await fixture.user.click(screen.getByRole("button", { name: choice }));
        if (choice === "Submit")
          expect(save).toHaveBeenCalledExactlyOnceWith("Typed prefix Beginning and final words");
        else expect(save).not.toHaveBeenCalled();
        if (choice === "Keep editing") {
          expect(close).not.toHaveBeenCalled();
          expect(document.activeElement).toBe(input);
          expect(input.value).toBe("Typed prefix Beginning and final words");
        } else expect(close).toHaveBeenCalledOnce();
        expect(message().value).toBe("");
      } finally {
        view.unmount();
      }
    },
  );

  it.each(["Enter", "button"])(
    "explicit annotation %s waits for final words without asking for dismissal confirmation",
    async (submit) => {
      using fixture = renderDictation();
      await fixture.user.click(mode());
      const save = vi.fn();
      const close = vi.fn();
      const view = render(
        <StoreProvider store={fixture.root.dictationStore}>
          <AnnotationDraftPopover anchor={document.body} onSave={save} onClose={close} />
        </StoreProvider>,
      );
      try {
        const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Annotation comment",
        });
        await fixture.user.type(input, "Typed prefix");
        await fixture.audio.push(new Float32Array(12_800).fill(0.1));
        await fixture.audio.push(new Float32Array(3200));
        if (submit === "Enter") await fixture.user.keyboard("{Enter}");
        else await fixture.user.click(screen.getByRole("button", { name: "Add annotation" }));
        // A click during explicit submission cannot interrupt finalization or open a second decision.
        await fixture.user.click(message());
        expect(save).not.toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).toBeNull();
        await fixture.recognize(0, "Beginning");
        await waitFor(() => expect(fixture.requests).toHaveLength(2));
        await fixture.recognize(1, "Beginning and final words");
        await waitFor(() =>
          expect(save).toHaveBeenCalledExactlyOnceWith("Typed prefix Beginning and final words"),
        );
        expect(close).toHaveBeenCalledOnce();
        expect(screen.queryByRole("alertdialog")).toBeNull();
      } finally {
        view.unmount();
      }
    },
  );

  it("keeps the annotation editable when final transcription fails", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    const save = vi.fn();
    const close = vi.fn();
    const view = render(
      <StoreProvider store={fixture.root.dictationStore}>
        <AnnotationDraftPopover anchor={document.body} onSave={save} onClose={close} />
      </StoreProvider>,
    );
    try {
      const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Annotation comment",
      });
      await fixture.user.type(input, "Typed prefix");
      await fixture.audio.push(new Float32Array(12_800).fill(0.1));
      await fixture.recognize(0, "Visible speech");
      await fixture.audio.push(new Float32Array(3200));
      await fixture.user.click(message());
      await waitFor(() => expect(fixture.requests).toHaveLength(2));
      await act(async () => {
        fixture.requests[1]!.reply.reject(engineFailure());
      });
      await screen.findByText(
        "Dictation could not finish. Keep editing to retry, or discard the draft.",
      );
      expect(input.value).toBe("Typed prefix Visible speech");
      expect(save).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(input.value).toBe("Typed prefix Visible speech");
      expect(document.activeElement).toBe(input);
    } finally {
      view.unmount();
    }
  });

  it("protects detected annotation speech even before the first text arrives", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    const close = vi.fn();
    const view = render(
      <StoreProvider store={fixture.root.dictationStore}>
        <AnnotationDraftPopover anchor={document.body} onSave={vi.fn()} onClose={close} />
      </StoreProvider>,
    );
    try {
      const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Annotation comment",
      });
      await fixture.user.click(input);
      await fixture.audio.push(new Float32Array(12_800).fill(0.1));
      await fixture.user.click(message());
      expect(screen.getByRole("alertdialog")).toBeDefined();
      expect(close).not.toHaveBeenCalled();
      await fixture.recognize(0, "Not lost before transcription");
      await waitFor(() => expect(fixture.requests).toHaveLength(2));
      await fixture.recognize(1, "Not lost before transcription");
      await waitFor(() =>
        expect(
          screen.getByRole<HTMLButtonElement>("button", { name: "Keep editing" }).disabled,
        ).toBe(false),
      );
      await fixture.user.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(input.value).toBe("Not lost before transcription");
      expect(document.activeElement).toBe(input);
    } finally {
      view.unmount();
    }
  });

  it("keeps a silent annotation field dictating after blur", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    const close = vi.fn();
    const view = render(
      <StoreProvider store={fixture.root.dictationStore}>
        <AnnotationItemPopover
          anchor={document.body}
          annotation={{ selectedText: "Selected passage", comment: "Existing note" }}
          onClose={close}
          onSave={close}
          onRemove={close}
        />
      </StoreProvider>,
    );
    try {
      await fixture.user.click(screen.getByRole("button", { name: "Edit annotation" }));
      const edit = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Edit annotation comment",
      });
      await fixture.audio.push(new Float32Array(12_800));
      await act(async () =>
        screen.getByRole<HTMLButtonElement>("button", { name: "Save annotation" }).focus(),
      );
      listening();
      await fixture.recognize(0, "Speech after blur");
      // Opening the editor selects the note; speech replaces that selection, focus or not.
      expect(edit.value).toBe("Speech after blur");
    } finally {
      view.unmount();
    }
  });

  it("isolates delayed annotation speech across annotation replacement and composer focus", async () => {
    using fixture = renderDictation();
    await fixture.user.type(message(), "Composer draft");
    await fixture.user.click(mode());
    const close = vi.fn();
    const save = vi.fn();
    const annotation = (key: number, comment: string) => (
      <StoreProvider store={fixture.root.dictationStore}>
        <AnnotationItemPopover
          key={key}
          anchor={document.body}
          annotation={{ selectedText: "Selected passage", comment }}
          onClose={close}
          onSave={save}
          onRemove={close}
        />
      </StoreProvider>
    );
    const view = render(annotation(1, "First note"));
    try {
      await fixture.user.click(screen.getByRole("button", { name: "Edit annotation" }));
      const edit = () =>
        screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit annotation comment" });
      act(() => {
        edit().setSelectionRange(edit().value.length, edit().value.length);
        fireEvent.select(edit());
      });
      await fixture.audio.push(new Float32Array(12_800).fill(0.1));
      act(() => screen.getByRole<HTMLButtonElement>("button", { name: "Save annotation" }).focus());
      await fixture.recognize(0, "Visible first speech");
      expect(edit().value).toBe("First note Visible first speech");
      await fixture.audio.push(new Float32Array(12_800));

      // A different annotation has a different insertion and generation, even at the same UI location.
      view.rerender(annotation(2, "Second note"));
      await fixture.user.click(screen.getByRole("button", { name: "Edit annotation" }));
      act(() => {
        edit().setSelectionRange(edit().value.length, edit().value.length);
        fireEvent.select(edit());
      });
      await fixture.recognize(1, "Late first annotation tail");
      expect(edit().value).toBe("Second note");
      await fixture.audio.push(new Float32Array(12_800));
      await fixture.recognize(2, "Second speech");
      expect(edit().value).toBe("Second note Second speech");
      await fixture.audio.push(new Float32Array(12_800));
      // Forced parent teardown is distinct from a user dismissal, which is now guarded.
      view.unmount();
      await fixture.user.click(message());
      await fixture.recognize(3, "Late second annotation tail");
      expect(message().value).toBe("Composer draft");
      listening();
      await fixture.audio.push(new Float32Array(12_800));
      await fixture.recognize(4, "Composer speech");
      expect(message().value).toBe("Composer draft Composer speech");
    } finally {
      view.unmount();
    }
  });

  it("drains queued worklet audio before a reused device can feed a new field", async () => {
    const flush = deferred<void>();
    using fixture = renderDictation({ flushReady: flush.promise });
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    listening();
    await fixture.user.click(message());
    expect(fixture.root.dictationStore.phase).toBe("preparing");
    await fixture.audio.push(new Float32Array(16_384).fill(0.1));
    expect(fixture.requests).toHaveLength(0);
    await act(async () => flush.resolve());
    listening();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "After the fence");
    expect(message().value).toBe("After the fence");
    expect(trial().value).toBe("");
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
  });

  it("cancels a pending worklet finish before opening a fresh device for the next field", async () => {
    const flush = deferred<void>();
    using fixture = renderDictation({ flushReady: flush.promise });
    await fixture.user.type(message(), "Keep draft");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.user.keyboard("{Enter}");
    expect(fixture.root.dictationStore.phase).toBe("finishing");
    await fixture.user.click(trial());
    listening();
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.audio.getUserMedia).toHaveBeenCalledTimes(2);
    await act(async () => flush.resolve());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Fresh field speech");
    expect(message().value).toBe("Keep draft");
    expect(trial().value).toBe("Fresh field speech");
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  // Another app, the desktop, a second monitor, Browser Mode's page and the VS Code panel all
  // take focus from Cake's page the same way: the focused field blurs, then the window does.
  it.each(["before", "after"])(
    "keeps the microphone live when Cake's page loses focus %s speech, including during a focus gap",
    async (when) => {
      using fixture = renderDictation();
      await fixture.user.click(mode());
      await fixture.user.click(trial());
      listening();
      if (when === "after") {
        await fixture.audio.push(new Float32Array(12_800).fill(0.1));
        await fixture.recognize(0, "Before");
      }
      await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      act(() => {
        fireEvent.blur(document.activeElement!);
        fireEvent(window, new Event("blur"));
      });
      listening();
      expect(fixture.audio.tracks[0]!.stop).not.toHaveBeenCalled();
      expect(fixture.root.dictationStore.activeTargetId).toBeDefined();
      await fixture.audio.push(new Float32Array(12_800).fill(0.1));
      await fixture.recognize(fixture.requests.length - 1, "Before and while away");
      expect(trial().value).toBe("Before and while away");
      // Coming back continues the same capture instead of reopening the device.
      hasFocus.mockReturnValue(true);
      act(() => fireEvent(window, new Event("focus")));
      hasFocus.mockRestore();
      listening();
      expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
      await fixture.audio.push(new Float32Array(12_800).fill(0.1));
      expect(fixture.requests.at(-1)!.audio.utteranceId).toBe(
        fixture.requests[0]!.audio.utteranceId,
      );
    },
  );

  it("keeps composer dictation when a Browser Mode page takes focus from the field", async () => {
    using fixture = renderDictation();
    await fixture.user.type(message(), "Draft");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    listening();
    // The embedded page is a separate WebContentsView: Cake's field and page blur with no
    // related DOM target, exactly as when another application takes focus.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => {
      fireEvent.blur(message(), { relatedTarget: null });
      fireEvent(window, new Event("blur"));
    });
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    await fixture.recognize(0, "spoken while browsing");
    hasFocus.mockRestore();
    expect(message().value).toBe("Draft spoken while browsing");
    listening();
    expect(fixture.audio.tracks[0]!.stop).not.toHaveBeenCalled();
    // Escape still ends it once Cake has keyboard focus again.
    await fixture.user.keyboard("{Escape}");
    expect(fixture.root.dictationStore.activeTargetId).toBeUndefined();
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
  });

  it.each(["mute", "disable"])("explicit %s wins over speech retained after blur", async (stop) => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    await fixture.recognize(0, "Keep visible speech");
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    listening();
    await fixture.user.click(
      stop === "mute" ? screen.getByRole("button", { name: "Mute dictation" }) : mode(),
    );
    await fixture.recognize(1, "Late stopped speech");
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    expect(message().value).toBe("Keep visible speech");
    expect(fixture.root.dictationStore.phase).toBe(stop === "mute" ? "paused" : "off");
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
  });

  it("releases a retained microphone when dictation is disabled", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    listening();
    await fixture.user.click(mode());
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("preserves selected text through noise-only results and edits only when recognition changes", async () => {
    using fixture = renderDictation();
    await fixture.user.type(message(), "Keep chosen text");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    act(() => {
      message().setSelectionRange(5, 11);
      fireEvent.select(message());
    });
    const input = vi.fn();
    message().addEventListener("input", input);
    for (const [index, text] of ["", " \n ", "spoken", "spoken", " spoken "].entries()) {
      await fixture.audio.push(new Float32Array(12_800).fill(0.1));
      await fixture.recognize(index, text);
      if (index < 2) {
        expect(message().value).toBe("Keep chosen text");
        expect([message().selectionStart, message().selectionEnd]).toEqual([5, 11]);
        expect(input).not.toHaveBeenCalled();
      } else {
        expect(message().value).toBe("Keep spoken text");
        expect(input).toHaveBeenCalledOnce();
      }
    }
  });

  it("replaces punctuation revisions without duplicating or stripping recognizer punctuation", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.user.type(message(), "Typed prefix:");
    const revisions = [
      "Why?",
      "Why??",
      "Why??",
      "Why does this happen?",
      "Why does this happen? Next phrase.",
    ];
    for (const [index, text] of revisions.entries()) {
      await fixture.audio.push(new Float32Array(12_800));
      await fixture.recognize(index, text);
      expect(message().value).toBe(`Typed prefix: ${text}`);
    }
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

  it("uses the same mute action for keyboard commands with active and inactive capture", async () => {
    using fixture = renderDictation({ hotkeys: true });
    const tap = (code = "AltRight") => {
      fireEvent.keyDown(document.activeElement ?? window, { key: "Alt", code, altKey: true });
      fireEvent.keyUp(document.activeElement ?? window, { key: "Alt", code });
    };
    fixture.root.settingsStore.hotkeys.assign("toggle-dictation-mute", "AltRight");
    tap();
    expect(fixture.root.dictationStore.muted).toBe(false); // Disabled dictation stays disabled.
    await fixture.user.click(mode());
    expect(fixture.root.dictationStore.muted).toBe(false);
    await fixture.user.click(trial());
    listening();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Keep this");
    tap("AltLeft");
    expect(fixture.root.dictationStore.muted).toBe(false);
    tap();
    expect(screen.getByRole("button", { name: "Unmute dictation" })).toBeDefined();
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(trial().value).toBe("Keep this");
    tap();
    await waitFor(listening);
    expect(fixture.audio.getUserMedia).toHaveBeenCalledTimes(2);
    await fixture.user.click(mode());
    expect(fixture.root.dictationStore.enabled).toBe(false);
    await fixture.user.click(mode());
    // No active capture/target is required to update the same shared mute preference.
    const target = fixture.root.dictationStore.activeTargetId;
    if (target) fixture.root.dictationStore.releaseTarget(target);
    tap();
    expect(fixture.root.dictationStore.muted).toBe(true);
    await waitFor(() => expect(fixture.setMuted).toHaveBeenLastCalledWith({ muted: true }));
  });

  it("pauses when another window claims the one capture and reclaims on refocus", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    listening();
    await waitFor(() => expect(fixture.claim).toHaveBeenCalledOnce());
    fixture.otherWindow({ claim: true });
    expect(fixture.root.dictationStore.phase).toBe("paused");
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    await fixture.user.click(message());
    listening();
    expect(fixture.claim).toHaveBeenCalledTimes(2);
    expect(fixture.root.dictationStore.phase).toBe("listening");
  });

  it("shares mute across windows; another window's unmute resumes only a focused field", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    listening();
    fixture.otherWindow({ muted: true });
    expect(fixture.root.dictationStore.phase).toBe("paused");
    expect(screen.getByRole("button", { name: "Unmute dictation" })).toBeDefined();
    fixture.otherWindow({ muted: false });
    await waitFor(listening);
    await fixture.user.click(screen.getByRole("button", { name: "Mute dictation" }));
    expect(fixture.setMuted).toHaveBeenCalledWith({ muted: true });
    expect(fixture.root.dictationStore.state?.muted).toBe(true);
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

  for (const [mode, minimum, length, cleaned] of [
    ["utility", 280, 279, false],
    ["utility", 280, 280, true],
    ["utility", 280, 281, true],
    ["utility", 0, 2, true],
    ["raw", 0, 281, false],
  ] as const) {
    it(`dictation uses shared cleanup policy: ${mode}, minimum ${minimum}, length ${length}`, async () => {
      const cleanup = speechCleanupFixture(minimum);
      using f = renderDictation({
        client: { workspaces: { postProcessDictation: cleanup.postProcess } },
      });
      await f.user.selectOptions(screen.getByRole("combobox", { name: "Text processing" }), mode);
      await f.user.click(screen.getByRole("switch", { name: "Dictation mode" }));
      await f.user.click(message());
      await f.audio.push(new Float32Array(12_800));
      const raw = "x".repeat(length);
      await f.recognize(0, raw);
      await f.user.keyboard("{Enter}");
      await f.recognize(1, raw);
      await waitFor(() =>
        expect(f.prompt).toHaveBeenCalledWith(
          expect.objectContaining({ text: cleaned ? "Cleaned speech." : raw }),
          expect.any(Object),
        ),
      );
      expect(cleanup.complete).toHaveBeenCalledTimes(cleaned ? 1 : 0);
    });
  }

  it("cleans the current insertion before submission without rewriting typed text", async () => {
    const result = deferred<string>();
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      () => result.promise,
    );
    using fixture = renderDictation({ client: { workspaces: { postProcessDictation } } });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.type(message(), "Typed prefix: ");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "Um, use Redis. Never mind, scratch that. Use SQLite.");
    await fixture.user.keyboard("{Enter}");
    await fixture.recognize(1, "Um, use Redis. Never mind, scratch that. Use SQLite.");
    expect(postProcessDictation).toHaveBeenCalledWith(
      "Um, use Redis. Never mind, scratch that. Use SQLite.",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.prompt).not.toHaveBeenCalled();
    const pending = document.querySelector('[data-slot="provisional-text"]');
    expect(pending?.textContent).toBe("Um, use Redis. Never mind, scratch that. Use SQLite.");
    expect(pending?.className).toContain("text-muted-foreground");
    expect(message().value).toBe(
      "Typed prefix: Um, use Redis. Never mind, scratch that. Use SQLite.",
    );
    await act(async () => result.resolve("Use SQLite."));
    expect(document.querySelector('[data-slot="provisional-text"]')).toBeNull();
    await waitFor(() =>
      expect(fixture.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Typed prefix: Use SQLite." }),
        expect.any(Object),
      ),
    );
  });

  it("retracts only the dictated insertion when cleanup returns empty text", async () => {
    const result = deferred<string>();
    using fixture = renderDictation({
      client: { workspaces: { postProcessDictation: () => result.promise } },
    });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.type(message(), "Typed prefix: ");
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.user.keyboard("{Enter}");
    await fixture.recognize(0, "Use Redis. Never mind, scratch that.");
    await act(async () => result.resolve(""));
    await waitFor(() =>
      expect(fixture.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Typed prefix:" }),
        expect.any(Object),
      ),
    );
  });

  it("cancels submission and protects edits while Enter cleanup is pending", async () => {
    const result = deferred<string>();
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      () => result.promise,
    );
    using fixture = renderDictation({ client: { workspaces: { postProcessDictation } } });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(4096).fill(0.1));
    await fixture.user.keyboard("{Enter}");
    await fixture.recognize(0, "Raw. Words.");
    await fixture.user.type(message(), " edited");
    await act(async () => result.resolve("Clean words."));
    expect(message().value).toBe("Raw. Words. edited");
    expect(document.querySelector('[data-slot="provisional-text"]')).toBeNull();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it("ignores a late cleanup when the user changes focus during finishing", async () => {
    const result = deferred<string>();
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      () => result.promise,
    );
    using fixture = renderDictation({ client: { workspaces: { postProcessDictation } } });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(4096).fill(0.1));
    await fixture.user.keyboard("{Enter}");
    await fixture.recognize(0, "Raw. Words.");
    expect(postProcessDictation).toHaveBeenCalledOnce();
    await fixture.user.click(trial());
    expect(postProcessDictation.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await act(async () => result.resolve("Clean words."));
    expect(message().value).toBe("Raw. Words.");
    expect(trial().value).toBe("");
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it.each([
    { changed: false, pending: false },
    { changed: true, pending: false },
    { changed: false, pending: true },
    { changed: true, pending: true },
  ])(
    "after a three-second pause Enter reuses cleanup unless text changed ($changed, pending $pending)",
    async ({ changed, pending }) => {
      let raw = "We need to. Do that.";
      const result = deferred<string>();
      const postProcessDictation = vi
        .fn<Client["workspaces"]["postProcessDictation"]>()
        .mockImplementationOnce(() => result.promise)
        .mockResolvedValue("We need to do that. Next question?");
      using fixture = renderDictation({
        client: {
          dictation: { transcribe: async () => raw },
          workspaces: { postProcessDictation },
        },
      });
      await fixture.user.selectOptions(
        screen.getByRole("combobox", { name: "Text processing" }),
        "utility",
      );
      await fixture.user.click(mode());
      await fixture.user.click(message());
      await fixture.audio.push(new Float32Array(16_384).fill(0.1));
      expect(postProcessDictation).not.toHaveBeenCalled();
      // Eleven detector frames are 2.816 seconds: not yet a cleanup trigger.
      for (let i = 0; i < 11; i++) await fixture.audio.push(new Float32Array(4096));
      expect(postProcessDictation).not.toHaveBeenCalled();
      await fixture.audio.push(new Float32Array(4096));
      await waitFor(() => expect(postProcessDictation).toHaveBeenCalledOnce());
      // More silence does not cause another call.
      for (let i = 0; i < 4; i++) await fixture.audio.push(new Float32Array(4096));
      expect(postProcessDictation).toHaveBeenCalledOnce();
      if (!pending) {
        await act(async () => result.resolve("We need to do that."));
        expect(message().value).toBe("We need to do that.");
        expect(document.querySelector('[data-slot="provisional-text"]')).toBeNull();
      }
      if (changed) raw = "We need to. Do that. Next question?";
      await fixture.user.keyboard("{Enter}");
      if (pending) {
        expect(fixture.prompt).not.toHaveBeenCalled();
        await act(async () => result.resolve("We need to do that."));
      }
      await waitFor(() =>
        expect(fixture.prompt).toHaveBeenCalledWith(
          expect.objectContaining({
            text: changed ? "We need to do that. Next question?" : "We need to do that.",
          }),
          expect.any(Object),
        ),
      );
      expect(postProcessDictation).toHaveBeenCalledTimes(changed ? 2 : 1);
    },
  );

  it("does not clean noise-only input and resets the silence countdown on resumed speech", async () => {
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      async () => "Clean words",
    );
    using fixture = renderDictation({
      client: {
        dictation: { transcribe: async () => "Raw words" },
        workspaces: { postProcessDictation },
      },
    });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    for (let i = 0; i < 12; i++) await fixture.audio.push(new Float32Array(4096));
    expect(postProcessDictation).not.toHaveBeenCalled();
    await fixture.audio.push(new Float32Array(16_384).fill(0.1));
    for (let i = 0; i < 11; i++) await fixture.audio.push(new Float32Array(4096));
    await fixture.audio.push(new Float32Array(16_384).fill(0.1));
    for (let i = 0; i < 11; i++) await fixture.audio.push(new Float32Array(4096));
    expect(postProcessDictation).not.toHaveBeenCalled();
    await fixture.audio.push(new Float32Array(4096));
    await waitFor(() => expect(trial().value).toBe("Clean words"));
    expect(postProcessDictation).toHaveBeenCalledOnce();
  });

  it("rejects outdated pause cleanup when more words arrive", async () => {
    let raw = "We need to. Do that.";
    const result = deferred<string>();
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      () => result.promise,
    );
    using fixture = renderDictation({
      client: { dictation: { transcribe: async () => raw }, workspaces: { postProcessDictation } },
    });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    await fixture.audio.push(new Float32Array(16_384).fill(0.1));
    for (let i = 0; i < 12; i++) await fixture.audio.push(new Float32Array(4096));
    await waitFor(() => expect(postProcessDictation).toHaveBeenCalledOnce());
    raw += " Next question?";
    await fixture.audio.push(new Float32Array(16_384).fill(0.1));
    await act(async () => result.resolve("We need to do that."));
    expect(trial().value).toBe(raw);
    expect(postProcessDictation).toHaveBeenCalledOnce();
  });

  it("submits the raw transcript if the optional cleanup transport fails", async () => {
    using fixture = renderDictation({
      client: {
        workspaces: {
          postProcessDictation: async () => {
            throw new Error("Offline");
          },
        },
      },
    });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(4096).fill(0.1));
    await fixture.user.keyboard("{Enter}");
    await fixture.recognize(0, "Keep raw speech.");
    await waitFor(() =>
      expect(fixture.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Keep raw speech." }),
        expect.any(Object),
      ),
    );
  });

  it("cancels pause cleanup on manual edits", async () => {
    const result = deferred<string>();
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      () => result.promise,
    );
    using fixture = renderDictation({
      client: {
        dictation: { transcribe: async () => "We need to. Do that." },
        workspaces: { postProcessDictation },
      },
    });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "utility",
    );
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    await fixture.audio.push(new Float32Array(16_384).fill(0.1));
    for (let i = 0; i < 12; i++) await fixture.audio.push(new Float32Array(4096));
    await waitFor(() => expect(postProcessDictation).toHaveBeenCalledOnce());
    await fixture.user.type(trial(), " Manual addition");
    await act(async () => result.resolve("We need to do that."));
    expect(trial().value).toBe("We need to. Do that. Manual addition");
  });

  it("remembers opting out and submits raw speech without a utility call", async () => {
    const postProcessDictation = vi.fn<Client["workspaces"]["postProcessDictation"]>(
      async () => "Unexpected",
    );
    using fixture = renderDictation({ client: { workspaces: { postProcessDictation } } });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Text processing" }),
      "raw",
    );
    expect(toSnapshot(fixture.root)?.children?.dictationStore).toMatchObject({
      state: { textProcessingMode: "raw" },
    });
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(4096).fill(0.1));
    await fixture.user.keyboard("{Enter}");
    await fixture.recognize(0, "Um raw. Speech.");
    await waitFor(() =>
      expect(fixture.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Um raw. Speech." }),
        expect.any(Object),
      ),
    );
    expect(postProcessDictation).not.toHaveBeenCalled();
  });

  it.each(["keyboard", "button", "normal submit contract"])(
    "%s submission drains speech once, releases ownership and needs new intentional focus",
    async (path) => {
      const admitted = deferred<void>();
      using f = renderDictation({ composerFocusEnabled: true, submissionReady: admitted.promise });
      await f.user.type(message(), "Typed");
      await f.user.click(mode());
      await f.user.click(message());
      await f.audio.push(new Float32Array(12_800).fill(0.1));
      let contract: Promise<boolean> | undefined;
      if (path === "keyboard") await f.user.keyboard("{Enter}");
      else if (path === "button") await f.user.click(screen.getByRole("button", { name: "Send" }));
      else
        act(() => {
          contract = f.submitContract();
        });
      await f.recognize(0, "Pending speech");
      await waitFor(() => expect(f.requests).toHaveLength(2));
      await f.recognize(1, "Pending speech and final words");
      await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
      expect(f.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Typed Pending speech and final words" }),
        expect.any(Object),
      );
      await f.audio.push(new Float32Array(12_800).fill(0.1));
      expect(f.requests).toHaveLength(2);
      await act(async () => {
        admitted.resolve();
        await contract;
      });
      expect(message().value).toBe("");
      expect(f.root.dictationStore.activeTargetId).toBeUndefined();
      expect(f.root.dictationStore.phase).toBe("paused");
      expect(document.activeElement).not.toBe(message());
      f.requestFocus();
      await waitFor(() => expect(document.activeElement).toBe(message().parentElement));
      fireEvent.select(message());
      fireEvent(window, new Event("focus"));
      await f.audio.push(new Float32Array(12_800).fill(0.1));
      expect(f.requests).toHaveLength(2);
      expect(message().value).toBe("");
      await f.user.click(message());
      listening();
      await f.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
      listening();
    },
  );

  it("hides the indicator while admission is pending and releases ownership once admitted", async () => {
    const admitted = deferred<void>();
    using f = renderDictation({ submissionReady: admitted.promise });
    await f.user.type(message(), "Typed request");
    await f.user.click(mode());
    await f.user.click(message());
    await f.user.keyboard("{Enter}");
    await waitFor(() => expect(f.requests).toHaveLength(1));
    await f.recognize(0, "");
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    expect(f.root.dictationStore.phase).toBe("paused");
    expect(screen.queryByRole("button", { name: "Mute dictation" })).toBeNull();
    await act(async () => admitted.resolve());
    expect(message().value).toBe("");
    expect(f.root.dictationStore.activeTargetId).toBeUndefined();
    expect(f.root.dictationStore.phase).toBe("paused");
  });

  it("a typed send during microphone preparation cannot rearm from late permission", async () => {
    const permission = deferred<void>();
    using f = renderDictation({ permission: permission.promise });
    await f.user.type(message(), "Typed before microphone readiness");
    await f.user.click(mode());
    await f.user.click(message());
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    await act(async () => permission.resolve());
    expect(message().value).toBe("");
    expect(f.root.dictationStore.activeTargetId).toBeUndefined();
    expect(f.root.dictationStore.phase).toBe("paused");
    expect(f.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(0);
  });

  it("a Send click during Enter finishing waits for the same complete transcription and submits once", async () => {
    using f = renderDictation();
    await f.user.type(message(), "Typed");
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    await f.user.keyboard("{Enter}");
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    expect(f.prompt).not.toHaveBeenCalled();
    await f.recognize(0, "Pending words");
    await waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.prompt).not.toHaveBeenCalled();
    await f.recognize(1, "All words");
    await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Typed All words" }),
      expect.any(Object),
    );
    expect(f.root.dictationStore.activeTargetId).toBeUndefined();
  });

  it("editing while a Send click drains speech cancels that submission without losing the edit", async () => {
    using f = renderDictation();
    await f.user.type(message(), "Typed");
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    await f.user.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(message(), { target: { value: "Intentional edit" } });
    await f.recognize(0, "Late words");
    expect(f.prompt).not.toHaveBeenCalled();
    expect(message().value).toBe("Intentional edit");
  });

  it.each(["finishing", "admission"])(
    "Escape during %s cancels dictation ownership without rearm",
    async (stage) => {
      const admitted = deferred<void>();
      using f = renderDictation({ submissionReady: admitted.promise });
      await f.user.type(message(), "Typed");
      await f.user.click(mode());
      await f.user.click(message());
      await f.audio.push(new Float32Array(12_800).fill(0.1));
      await f.user.keyboard("{Enter}");
      if (stage === "admission") {
        await f.recognize(0, "Speech");
        await waitFor(() => expect(f.requests).toHaveLength(2));
        await f.recognize(1, "Final speech");
        await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
      }
      await f.user.keyboard("{Escape}");
      if (stage === "finishing") await f.recognize(0, "Stale words");
      await act(async () => admitted.resolve());
      expect(f.root.dictationStore.activeTargetId).toBeUndefined();
      expect(f.root.dictationStore.phase).toBe("paused");
      expect(f.prompt).toHaveBeenCalledTimes(stage === "admission" ? 1 : 0);
      if (stage === "finishing") expect(message().value).toBe("Typed");
      await f.audio.push(new Float32Array(12_800).fill(0.1));
      expect(f.requests).toHaveLength(stage === "admission" ? 2 : 1);
    },
  );

  it("retains the dictated draft and resumes the same owner when submission is rejected", async () => {
    const rejected = deferred<TurnId>();
    using f = renderDictation({ client: { sessionChats: { prompt: () => rejected.promise } } });
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    await f.recognize(0, "Preserved speech");
    await f.user.keyboard("{Enter}");
    await waitFor(() => expect(f.requests).toHaveLength(2));
    await f.recognize(1, "Preserved final speech");
    await act(async () => {
      rejected.reject(new Error("Admission rejected"));
      await rejected.promise.catch(() => undefined);
    });
    await waitFor(listening);
    expect(message().value).toBe("Preserved final speech");
    expect(f.root.dictationStore.activeTargetId).toBeDefined();
    await f.audio.push(new Float32Array(12_800));
    await f.recognize(2, "Retry draft");
    expect(message().value).toBe("Preserved final speech Retry draft");
  });

  it.each(["focused", "blurred sticky", "indicator-focused"])(
    "Escape stops a %s owner without stale results or automatic rearm",
    async (where) => {
      using f = renderDictation({ composerFocusEnabled: true });
      await f.user.click(mode());
      await f.user.click(message());
      await f.audio.push(new Float32Array(12_800).fill(0.1));
      await f.recognize(0, "Keep dictated draft");
      await f.audio.push(new Float32Array(12_800));
      if (where === "blurred sticky")
        await f.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
      if (where === "indicator-focused")
        act(() =>
          screen.getByRole<HTMLButtonElement>("button", { name: "Mute dictation" }).focus(),
        );
      await f.user.keyboard("{Escape}");
      expect(f.root.dictationStore.activeTargetId).toBeUndefined();
      expect(f.root.dictationStore.phase).toBe("paused");
      await f.recognize(1, "Stale speech after Escape");
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      fireEvent(window, new Event("focus"));
      hasFocus.mockRestore();
      expect(f.root.dictationStore.activeTargetId).toBeUndefined();
      f.requestFocus();
      await waitFor(() => expect(document.activeElement).toBe(message().parentElement));
      fireEvent.select(message());
      fireEvent(window, new Event("focus"));
      await f.audio.push(new Float32Array(12_800).fill(0.1));
      expect(message().value).toBe("Keep dictated draft");
      expect(f.requests).toHaveLength(2);
      expect(f.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
      await f.user.click(message());
      listening();
      await f.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
      listening();
    },
  );

  it("leaves inactive Escape and already handled Escape alone", async () => {
    using f = renderDictation();
    await f.user.type(message(), "Typed draft");
    expect(fireEvent.keyDown(message(), { key: "Escape" })).toBe(true);
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    await f.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    const handled = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    fireEvent(window, handled);
    listening();
    expect(message().value).toBe("Typed draft");
  });

  it("drains pending and final audio before Enter submits exactly one complete message", async () => {
    using fixture = renderDictation();
    await fixture.user.click(mode());
    await fixture.user.click(message());
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    await fixture.audio.push(new Float32Array(3200));
    await fixture.user.keyboard("{Enter}{Enter}");
    expect(screen.getByText("Finishing…", { selector: "span" }).classList.contains("sr-only")).toBe(
      true,
    );
    const control = screen.getByRole("button", { name: "Mute dictation" });
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.querySelector('[role="status"]')).not.toBeNull();
    expect(control.closest('[data-slot="composer-dictation"]')).not.toBeNull();
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
    expect(fixture.root.dictationStore.activeTargetId).toBeUndefined();
    expect(fixture.root.dictationStore.phase).toBe("paused");
    expect(document.activeElement).not.toBe(message());
    await fixture.audio.push(new Float32Array(12_800).fill(0.1));
    expect(fixture.requests).toHaveLength(2);
    expect(message().value).toBe("");
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

  it("hands pending microphone preparation to the next focused field, even across a blur", async () => {
    const permission = deferred<void>();
    using fixture = renderDictation({ permission: permission.promise });
    await fixture.user.click(mode());
    await fixture.user.click(trial());
    expect(fixture.audio.getUserMedia).toHaveBeenCalledOnce();
    await fixture.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    await fixture.user.click(message());
    await act(async () => permission.resolve());
    listening();
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.audio.tracks[1]!.stop).not.toHaveBeenCalled();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(0, "After permission");
    expect(message().value).toBe("After permission");
    expect(trial().value).toBe("");
  });

  it("abandons a disconnected pending preparation RPC and retries freshly without waiting for its completion", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    const old = deferred<void>();
    f.prepare.mockImplementationOnce(() => old.promise);
    vi.useFakeTimers();
    await act(async () => {
      message().focus();
    });
    const signal = f.prepare.mock.calls.at(-1)![0]!.signal!;
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.audio.getUserMedia).not.toHaveBeenCalled();
    await act(async () => {
      f.root.dictationStore.reportObservationError();
      f.root.dictationStore.reportObservationError();
      f.root.dictationStore.reportObservationError();
    });
    expect(signal.aborted).toBe(true);
    await advanceRecovery(499);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    await advanceRecovery(1);
    listening();
    expect(f.prepare).toHaveBeenCalledTimes(3);
    // The old Promise may settle even after its command was aborted. It owns no new state.
    await act(async () => old.reject(engineFailure()));
    await advanceRecovery(DICTATION_PREPARATION_TIMEOUT_MS + 5000);
    listening();
    expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledTimes(3);
  });

  it("bounds missing preparation completions, aborts each RPC, exhausts backoff and offers a successful manual retry", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    const old: Array<ReturnType<typeof deferred<void>>> = [];
    f.prepare.mockImplementation(() => {
      const pending = deferred<void>();
      old.push(pending);
      return pending.promise;
    });
    vi.useFakeTimers();
    await act(async () => {
      message().focus();
    });
    for (const delay of [500, 1500, 4000]) {
      const signal = f.prepare.mock.calls.at(-1)![0]!.signal!;
      await advanceRecovery(DICTATION_PREPARATION_TIMEOUT_MS + 4999);
      expect(signal.aborted).toBe(false);
      await advanceRecovery(1);
      expect(signal.aborted).toBe(true);
      expect(f.audio.getUserMedia).not.toHaveBeenCalled();
      await advanceRecovery(delay);
    }
    await advanceRecovery(DICTATION_PREPARATION_TIMEOUT_MS + 5000);
    expect(screen.getByText(/Automatic recovery stopped.*preparation timed out/)).toBeDefined();
    expect(f.prepare).toHaveBeenCalledTimes(5); // enable preload, then initial capture + 3 retries
    await advanceRecovery(1_000_000);
    expect(f.prepare).toHaveBeenCalledTimes(5);
    f.prepare.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry dictation" }));
    });
    listening();
    await act(async () => {
      for (const pending of old) pending.resolve();
    });
    listening();
    expect(f.prepare).toHaveBeenCalledTimes(6);
    expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
  });

  it.each(["mute", "owner-release", "cancel", "disable", "field-switch"] as const)(
    "a late preparation completion after %s cannot revive the old capture or schedule retries",
    async (stop) => {
      using f = renderDictation();
      await f.user.click(mode());
      const old = deferred<void>();
      f.prepare.mockImplementationOnce(() => old.promise);
      vi.useFakeTimers();
      await act(async () => {
        message().focus();
      });
      const owner = f.root.dictationStore.activeTargetId!;
      await act(async () => {
        if (stop === "mute") f.root.dictationStore.setMuted(owner, true);
        else if (stop === "owner-release") f.root.dictationStore.releaseTarget(owner);
        else if (stop === "disable") await f.root.dictationStore.setEnabled(false);
        else if (stop === "field-switch") trial().focus();
        else f.root.dictationStore.pauseCapture();
      });
      // A field switch shares the warmup, but only the new field may open capture.
      expect(f.prepare).toHaveBeenCalledTimes(2);
      await act(async () => old.resolve());
      await advanceRecovery(DICTATION_PREPARATION_TIMEOUT_MS + 10_000);
      if (stop === "field-switch") {
        listening();
        expect(f.audio.getUserMedia).toHaveBeenCalledOnce();
        expect(f.root.dictationStore.activeTargetId).not.toBe(owner);
      } else {
        expect(f.audio.getUserMedia).not.toHaveBeenCalled();
        expect(f.root.dictationStore.phase).toBe(stop === "disable" ? "off" : "paused");
      }
      expect(f.prepare).toHaveBeenCalledTimes(2);
      expect(message().value).toBe("");
      expect(f.prompt).not.toHaveBeenCalled();
    },
  );

  it("recovers a transient decode failure once, preserves text and owner, and ignores duplicate/stale capture events", async () => {
    using f = renderDictation();
    await f.user.type(message(), "Typed draft");
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800));
    await f.recognize(0, "visible speech");
    const owner = f.root.dictationStore.activeTargetId;
    const oldTrack = f.audio.tracks[0]!;
    await f.audio.push(new Float32Array(12_800));
    vi.useFakeTimers();
    await act(async () => {
      f.requests[1]!.reply.reject(engineFailure());
    });
    expect(message().value).toBe("Typed draft visible speech");
    expect(f.root.dictationStore.activeTargetId).toBe(owner);
    expect(screen.getByText("Reconnecting dictation… (1/3)")).toBeDefined();
    await act(async () => {
      oldTrack.dispatchEvent(new Event("ended"));
      oldTrack.dispatchEvent(new Event("ended"));
    });
    await f.audio.push(new Float32Array(12_800), 0);
    await advanceRecovery(499);
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(1);
    await advanceRecovery(1);
    listening();
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(2);
    await f.audio.push(new Float32Array(12_800));
    expect(f.requests[2]!.audio.utteranceId).not.toBe(f.requests[1]!.audio.utteranceId);
    await f.recognize(2, "new speech");
    expect(message().value).toBe("Typed draft visible speech new speech");
    expect(f.root.dictationStore.activeTargetId).toBe(owner);
  });

  it("bounds repeated end/start failures at three retries with backoff; startup alone never resets the budget", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    await f.user.click(message());
    vi.useFakeTimers();
    for (const [index, delay] of [500, 1500, 4000].entries()) {
      await endMicrophone(f);
      await advanceRecovery(delay - 1);
      expect(f.audio.getUserMedia).toHaveBeenCalledTimes(index + 1);
      await advanceRecovery(1);
      listening();
    }
    await endMicrophone(f);
    expect(screen.getByText(/Automatic recovery stopped/)).toBeDefined();
    await advanceRecovery(60_000);
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(4);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry dictation" }));
    });
    listening();
    await endMicrophone(f);
    await advanceRecovery(500);
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(6);
  });

  it("recovers detector failure and observation interruption without a backend-ready focus veto", async () => {
    const detectSpeech = vi
      .fn<Client["dictation"]["detectSpeech"]>()
      .mockRejectedValueOnce(engineFailure("engine-exit"))
      .mockResolvedValue(true);
    using f = renderDictation({ client: { dictation: { detectSpeech } } });
    await f.user.click(mode());
    await f.user.click(message());
    vi.useFakeTimers();
    await f.audio.push(new Float32Array(4096));
    act(() =>
      f.root.dictationStore.applyState({
        ...installedDictationState,
        status: "error",
        message: "Worker exited",
      }),
    );
    await advanceRecovery(500);
    listening();
    await act(async () => f.root.dictationStore.reportObservationError());
    await advanceRecovery(1500);
    listening();
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("recovers bounded audio backlog by discarding uninserted audio, never replaying it", async () => {
    using f = renderDictation();
    await f.user.type(message(), "Keep text");
    await f.user.click(mode());
    await f.user.click(message());
    vi.useFakeTimers();
    await f.audio.push(new Float32Array(128_001));
    expect(screen.getByText("Reconnecting dictation… (1/3)")).toBeDefined();
    await advanceRecovery(500);
    listening();
    expect(f.requests).toHaveLength(0);
    expect(message().value).toBe("Keep text");
    await f.audio.push(new Float32Array(12_800));
    await f.recognize(0, "Fresh speech");
    expect(message().value).toBe("Keep text Fresh speech");
  });

  it("preserves recovery eligibility across speech-owning DOM blur, but unmount cancels it", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800).fill(0.1));
    await f.recognize(0, "Captured speech");
    await f.user.click(screen.getByRole("button", { name: "Refresh microphones" }));
    vi.useFakeTimers();
    await endMicrophone(f);
    await advanceRecovery(500);
    listening();
    expect(message().value).toBe("Captured speech");
    await endMicrophone(f);
    act(() => f.remountComposer());
    await advanceRecovery(60_000);
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("resets the retry budget only after 30 seconds of listening and a successful decode", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    await f.user.click(message());
    vi.useFakeTimers();
    await endMicrophone(f);
    await advanceRecovery(500);
    await advanceRecovery(30_000);
    await f.audio.push(new Float32Array(12_800));
    await f.recognize(0, "Healthy speech");
    await endMicrophone(f);
    await advanceRecovery(500);
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(3);
    expect(message().value).toBe("Healthy speech");
  });

  it.each([
    "mute",
    "disable",
    "window-pause",
    "owner-release",
    "send-or-Escape-owner-reset",
  ] as const)(
    "cancels pending recovery on %s and only fresh intentional activation starts another lifecycle",
    async (stop) => {
      using f = renderDictation();
      await f.user.type(message(), "Keep draft");
      await f.user.click(mode());
      await f.user.click(message());
      const owner = f.root.dictationStore.activeTargetId!;
      vi.useFakeTimers();
      await endMicrophone(f);
      await act(async () => {
        if (stop === "mute") f.root.dictationStore.setMuted(owner, true);
        else if (stop === "disable") await f.root.dictationStore.setEnabled(false);
        else if (stop === "owner-release") f.root.dictationStore.releaseTarget(owner);
        // Successful Send and Escape route through this owner-reset boundary. Their
        // key/submit wiring is covered by the separate blur/lifecycle implementation.
        else f.root.dictationStore.pauseCapture();
      });
      await endMicrophone(f);
      await advanceRecovery(60_000);
      expect(f.audio.getUserMedia).toHaveBeenCalledTimes(1);
      expect(message().value).toBe("Keep draft");
      if (stop === "owner-release" || stop === "send-or-Escape-owner-reset") {
        act(() => {
          fireEvent.blur(message());
          fireEvent.focus(message());
        });
        await act(async () => {});
        listening();
        await endMicrophone(f);
        await advanceRecovery(500);
        expect(f.audio.getUserMedia).toHaveBeenCalledTimes(3);
      }
    },
  );

  it("moves ownership during backoff without the old timer or recognition result inserting into either field", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800));
    vi.useFakeTimers();
    await endMicrophone(f);
    await act(async () => {
      trial().focus();
    });
    await f.recognize(0, "Late old speech");
    await advanceRecovery(10_000);
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(2);
    expect(message().value).toBe("");
    expect(trial().value).toBe("");
    await f.audio.push(new Float32Array(12_800));
    await f.recognize(1, "Correct field");
    expect(trial().value).toBe("Correct field");
  });

  it("ignores a failed decode from an insertion sealed by manual editing", async () => {
    using f = renderDictation();
    await f.user.click(mode());
    await f.user.click(message());
    await f.audio.push(new Float32Array(12_800));
    await f.user.type(message(), "Manual edit");
    await act(async () => {
      f.requests[0]!.reply.reject(engineFailure());
    });
    listening();
    expect(message().value).toBe("Manual edit");
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("does not recover finish/Enter failures or submit a truncated draft", async () => {
    using f = renderDictation();
    await f.user.type(message(), "Keep draft");
    await f.user.click(mode());
    await f.user.click(message());
    await f.user.keyboard("{Enter}");
    vi.useFakeTimers();
    await act(async () => {
      f.requests[0]!.reply.reject(engineFailure());
    });
    await advanceRecovery(60_000);
    expect(screen.getByRole("button", { name: "Retry dictation" })).toBeDefined();
    expect(f.prompt).not.toHaveBeenCalled();
    expect(message().value).toBe("Keep draft");
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it.each(["configuration", "unknown", "stopped"] as const)(
    "keeps %s errors actionable, with no automatic or typing-triggered retry",
    async (code) => {
      using f = renderDictation();
      await f.user.click(mode());
      await f.user.click(message());
      await f.audio.push(new Float32Array(12_800));
      vi.useFakeTimers();
      await act(async () => {
        f.requests[0]!.reply.reject(engineFailure(code));
      });
      act(() => {
        fireEvent.change(message(), { target: { value: "Still writable" } });
      });
      await advanceRecovery(60_000);
      expect(screen.getByRole("button", { name: "Retry dictation" })).toBeDefined();
      expect(f.audio.getUserMedia).toHaveBeenCalledTimes(1);
      expect(message().value).toBe("Still writable");
    },
  );

  it("retries temporary microphone acquisition failure and cancels a recovery still awaiting startup", async () => {
    using f = renderDictation();
    f.audio.getUserMedia.mockRejectedValueOnce(new DOMException("Device busy", "NotReadableError"));
    await f.user.click(mode());
    vi.useFakeTimers();
    await act(async () => {
      message().focus();
    });
    expect(screen.getByText("Reconnecting dictation… (1/3)")).toBeDefined();
    const opening = deferred<Awaited<ReturnType<typeof f.audio.getUserMedia>>>();
    f.audio.getUserMedia.mockImplementationOnce(() => opening.promise);
    await advanceRecovery(500);
    const owner = f.root.dictationStore.activeTargetId!;
    act(() => f.root.dictationStore.releaseTarget(owner));
    const track = new (class extends EventTarget {
      stop = vi.fn();
    })();
    await act(async () => {
      opening.resolve({ getTracks: () => [track], getAudioTracks: () => [] });
    });
    await advanceRecovery(60_000);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(2);
    expect(f.root.dictationStore.activeTargetId).toBeUndefined();
  });

  it("never retries microphone permission denial", async () => {
    using f = renderDictation();
    f.audio.getUserMedia.mockRejectedValue(
      new DOMException("Microphone permission denied", "NotAllowedError"),
    );
    await f.user.click(mode());
    await f.user.click(message());
    vi.useFakeTimers();
    await advanceRecovery(60_000);
    expect(screen.getByRole("button", { name: "Retry dictation" })).toBeDefined();
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("cancels backoff on disposal and emits only bounded metadata, not dictated text or raw errors", async () => {
    const f = renderDictation();
    try {
      await f.user.click(mode());
      await f.user.click(message());
      await f.audio.push(new Float32Array(12_800));
      await f.recognize(0, "SECRET DICTATED SENTENCE");
      await f.audio.push(new Float32Array(12_800));
      vi.useFakeTimers();
      await act(async () => {
        f.requests[1]!.reply.reject(
          engineFailure("engine-timeout", "SECRET RAW ERROR /private/path"),
        );
      });
      const report = voiceDiagnosticReport();
      expect(report).toContain('"code": "engine-timeout"');
      expect(report).toContain('"stage": "transcription"');
      expect(report).not.toContain("SECRET");
      expect(report).not.toContain("private details");
      expect(report).not.toContain(f.requests[0]!.audio.utteranceId);
      expect(JSON.parse(report).events.length).toBeLessThanOrEqual(100);
    } finally {
      f[Symbol.dispose]();
    }
    await advanceRecovery(60_000);
    expect(f.audio.getUserMedia).toHaveBeenCalledTimes(1);
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
    const errorStatus = screen.getByText("Engine stopped", { selector: "span" });
    expect(errorStatus.classList.contains("sr-only")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Retry dictation" })
        .classList.contains("text-destructive"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Retry dictation" })
        .closest('[data-slot="composer-dictation"]'),
    ).not.toBeNull();
    expect(fixture.audio.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(message().value).toBe("Keep draft");
    await fixture.user.click(screen.getByRole("button", { name: "Retry dictation" }));
    listening();
    await fixture.audio.push(new Float32Array(12_800));
    await fixture.recognize(1, "Recovered speech");
    expect(message().value).toBe("Keep draft Recovered speech");
  });
});
