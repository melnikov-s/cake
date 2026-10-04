/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import type { Microphone } from "../../../src/renderer/dictation/microphone";
import type { SpeechPlayback } from "../../../src/renderer/speech/playback";
import { Chat } from "../../../src/renderer/components/chat";
import { SettingsSpeechSection } from "../../../src/renderer/components/settings-speech-section";
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
    synthesize?: Client["speechOutput"]["synthesize"];
    enqueue?: SpeechPlayback["enqueue"];
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
    drain: vi.fn(async () => {}),
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
  const rootFixture = createRendererStoreFixture({
    snapshot: options.snapshot,
    microphone,
    speechPlayback: playback,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "one", projectPath: "/project" })],
    client: {
      dictation: { prepare: options.prepare ?? (async () => {}), release, transcribe },
      speechOutput: {
        synthesize,
        setApiKey,
        setVoice,
        listVoices: async () => [{ id: "voice", name: "Fixture voice" }],
      },
      sessionChats: { prompt, abort },
    },
  });
  const { root } = rootFixture;
  root.speechSettingsStore.applySettings({
    keyConfigured: true,
    voiceId: "voice",
    modelId: "eleven_flash_v2_5",
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
    <>
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
      <ToastHost store={root.toastStore} />
    </>,
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
    async say() {
      await this.frames(0.1, 4);
      await this.frames(0, 10);
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
  it("enter prepares local recognition and offers listening, input mute and exit on the existing Chat", async () => {
    using f = fixture();
    await f.enter();
    expect(screen.getByText("Listening")).toBeDefined();
    await f.user.click(screen.getByRole("button", { name: "Mute input" }));
    expect(f.root.conversationModeStore.muted).toBe(true);
    await f.user.click(screen.getByRole("button", { name: "Exit conversation mode" }));
    expect(f.root.conversationModeStore.phase).toBe("off");
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
          keyConfigured: kind !== "key",
          modelId: "eleven_flash_v2_5",
        });
      await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
      const toast = await screen.findByRole("alert");
      expect(toast.textContent).toContain("Conversation mode unavailable");
      expect(screen.getByRole("button", { name: "Open Speech output settings" })).toBeDefined();
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
        keyConfigured: false,
        modelId: "eleven_flash_v2_5",
      }),
    );
    await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
    const message = await screen.findByText(
      "Configure an ElevenLabs key and voice in Settings → Speech output.",
    );
    await f.user.click(message);
    expect(f.root.appShellStore.surface).toBe("settings");
    expect(f.root.settingsStore.activePage).toBe("speech");
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
    expect(screen.getByText("Listening")).toBeDefined();
    expect(restored.setApiKey).not.toHaveBeenCalled();
    expect(restored.setVoice).not.toHaveBeenCalled();
  });
  it("disabling speech during preparation prevents late completion from restarting audio or reporting an error", async () => {
    const preparation = deferred<void>();
    using f = fixture({ prepare: async () => preparation.promise });
    await f.user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
    expect(screen.getByText("Preparing voice…")).toBeDefined();
    render(<SettingsSpeechSection speech={f.root.speechSettingsStore} />);
    await f.user.click(screen.getByRole("switch", { name: "Enable speech" }));
    await act(async () => preparation.resolve());
    expect(screen.queryByText("Listening")).toBeNull();
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
    await f.frames(0, 20);
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });
  it("silence, brief noise and empty recognition do not submit or interrupt the assistant", async () => {
    using f = fixture({ transcribe: async () => "" });
    await f.enter();
    const stops = vi.mocked(f.playback.stop).mock.calls.length;
    await f.frames(0, 20);
    await f.frames(0.1, 1);
    await f.frames(0, 10);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops);
    expect(f.transcribe).not.toHaveBeenCalled();
    await f.frames(0.1, 4);
    await f.frames(0, 10);
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("speech input leaves the typed draft, pending attachments and annotations untouched", async () => {
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
    const annotations = draft.annotationDraft.annotations.slice();
    await f.enter();
    await f.say();
    expect(draft.text).toBe("Typed draft");
    expect(draft.visibleAttachments).toEqual(files);
    expect(draft.annotationDraft.annotations).toEqual(annotations);
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
  it("barge-in immediately silences playback and rejects late synthesis chunks without aborting agent work", async () => {
    const gate = deferred<void>();
    let consume: Parameters<Client["speechOutput"]["synthesize"]>[1] | undefined;
    using f = fixture({
      synthesize: async (_request, callback) => {
        consume = callback;
        await gate.promise;
      },
    });
    await f.enter();
    f.publish([consumed(), assistant("Speaking. ")]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    const stops = vi.mocked(f.playback.stop).mock.calls.length;
    await f.frames(0.1, 2);
    expect(f.playback.stop).toHaveBeenCalledTimes(stops + 1);
    await consume?.({ encoding: "pcm_s16le", sampleRate: 24000, pcm: "AAA=" });
    expect(f.playback.enqueue).not.toHaveBeenCalled();
    expect(f.abort).not.toHaveBeenCalled();
    gate.resolve();
  });
  it("barge-in suppresses the interrupted reply until the next user input is consumed rather than merely queued", async () => {
    using f = fixture();
    await f.enter();
    f.publish([consumed(), assistant("Old. ")]);
    await waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
    await f.frames(0.1, 2);
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
  it("muting stops and discards unfinished input while allowing output and accepted agent work to continue", async () => {
    using f = fixture();
    await f.enter();
    await f.frames(0.1, 2);
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
      await f.frames(0, 10);
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
  it("dictation and conversation capture exclude each other in the same window in either activation order", async () => {
    using f = fixture();
    await act(async () => {
      await f.root.dictationStore.setEnabled(true);
    });
    await f.enter();
    expect(f.root.dictationStore.enabled).toBe(false);
    await act(async () => {
      await f.root.dictationStore.setEnabled(true);
    });
    expect(f.root.conversationModeStore.phase).toBe("off");
    expect(f.root.dictationStore.enabled).toBe(true);
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
  it("speech settings save a masked transient key, clear its draft and select a voice without exposing stored credentials", async () => {
    using f = fixture();
    render(<SettingsSpeechSection speech={f.root.speechSettingsStore} />);
    const key = screen.getByLabelText("ElevenLabs API key");
    expect(key.getAttribute("type")).toBe("password");
    await f.user.type(key, "transient-key");
    await f.user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(f.root.speechSettingsStore.apiKeyDraft).toBe(""));
    expect(f.setApiKey).toHaveBeenCalledWith("transient-key", expect.any(Object));
    await f.user.click(screen.getByRole("button", { name: "Load voices" }));
    await screen.findByText("Fixture voice");
    await f.user.selectOptions(screen.getByLabelText("Voice"), "voice");
    expect(f.setVoice).toHaveBeenCalledWith("voice", expect.any(Object));
    expect(f.synthesize).not.toHaveBeenCalled();
  });
});
