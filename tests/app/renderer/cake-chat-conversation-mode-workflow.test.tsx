/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import type { Microphone } from "../../../src/renderer/dictation/microphone";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import type { SpeechPlayback } from "../../../src/renderer/speech/playback";
import { detectFixtureSpeech } from "../../helpers/speech-detection";
import { speechOutputSettings } from "../../helpers/speech-output";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

function cakeChatVoiceFixture(options: { materialized?: boolean; streaming?: boolean } = {}) {
  let onAudio: ((samples: Float32Array) => void) | undefined;
  const stopCapture = vi.fn();
  const microphone: Microphone = {
    open: vi.fn(async (callback) => {
      onAudio = callback;
      return { stop: stopCapture, finish: async () => {}, discardPending: async () => {} };
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
  const start = vi.fn<Client["cakeChats"]["start"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000002"),
  );
  const synthesize = vi.fn<Client["speechOutput"]["synthesize"]>(async (_request, consume) =>
    consume({ encoding: "pcm_s16le", sampleRate: 24000, pcm: "AAA=" }),
  );
  const fixture = createRendererStoreFixture({
    microphone,
    speechPlayback: playback,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "project-one", projectPath: "/project" })],
    client: {
      dictation: {
        prepare: async () => {},
        release: async () => {},
        transcribe: async () => "What is running right now",
        detectSpeech: detectFixtureSpeech,
      },
      speechOutput: { synthesize, listVoices: async () => [] },
      sessionChats: { prompt, abort: async () => {} },
      cakeChats: { start, setComposing: async () => {} },
    },
  });
  const { root } = fixture;
  root.speechSettingsStore.applySettings({
    ...speechOutputSettings(),
    keyConfigured: true,
    voiceId: "voice",
    modelId: "eleven_flash_v2_5",
    speed: 1,
    voices: [{ id: "voice", name: "Fixture voice" }],
  });
  // The permanent Cake Chat is pending until its first message reaches the backend.
  if (options.materialized === false)
    root.cakeChatCollectionStore.pendingSessions.create(CAKE_CHAT_SESSION_ID, "Cake Chat");
  else
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
    });
  const chat = root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
  const publish = (parts: UiPart[]) =>
    act(() => {
      applyConversationSnapshot(chat.model, {
        sessionId: CAKE_CHAT_SESSION_ID,
        sessionFile: "/cake-chat.sqlite",
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
      });
    });
  publish([
    {
      id: "history",
      renderKey: "history",
      kind: "text",
      role: "assistant",
      text: "Earlier answer that must not be replayed.",
      status: "complete",
    },
  ]);
  const view = render(
    <StoreProvider store={root.dictationStore}>
      <Chat store={chat.conversationSessionStore.chatStore} embedded composerFocusEnabled={false} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  return {
    root,
    chat,
    prompt,
    start,
    synthesize,
    stopCapture,
    user,
    publish,
    async enter() {
      await user.click(screen.getByRole("button", { name: "Enter conversation mode" }));
      await waitFor(() => expect(root.conversationModeStore.phase).toBe("active"));
    },
    async say() {
      await act(async () => {
        for (let i = 0; i < 4; i++) onAudio?.(new Float32Array(1600).fill(0.1));
        for (let i = 0; i < 33; i++) onAudio?.(new Float32Array(1600).fill(0));
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("Cake Chat offers the same voice controls and submits speech as an ordinary voice-mode turn", async () => {
  using f = cakeChatVoiceFixture();
  await f.enter();
  expect(f.root.conversationModeStore.sessionId).toBe(CAKE_CHAT_SESSION_ID);
  expect(screen.getByRole("button", { name: "Mute input", pressed: true })).toBeDefined();
  await f.say();
  await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
  expect(f.prompt.mock.calls[0]?.[0]).toMatchObject({
    sessionId: CAKE_CHAT_SESSION_ID,
    text: "What is running right now",
    responseMode: "voice",
  });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.synthesize).not.toHaveBeenCalled();
});

it("Cake Chat speaks only new assistant prose after spoken input, never its history", async () => {
  using f = cakeChatVoiceFixture();
  await f.enter();
  await f.say();
  await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
  f.publish([
    {
      id: "history",
      renderKey: "history",
      kind: "text",
      role: "assistant",
      text: "Earlier answer that must not be replayed.",
      status: "complete",
    },
    {
      id: "input",
      entryId: "input",
      kind: "text",
      role: "user",
      text: "What is running right now",
      status: "complete",
    },
    {
      id: "reply",
      renderKey: "reply",
      kind: "text",
      role: "assistant",
      text: "Two sessions are running. ",
      status: "streaming",
    },
  ]);
  await waitFor(() => expect(f.synthesize).toHaveBeenCalledOnce());
  expect(f.synthesize.mock.calls[0]?.[0]).toEqual({ text: "Two sessions are running." });
});

it("Cake Chat speaks a fast reply first published as its settled original, never older loaded history", async () => {
  using f = cakeChatVoiceFixture();
  await f.enter();
  await f.say();
  await waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
  const now = Date.now();
  const reply = (text: string, timestamp: number) => ({
    role: "assistant" as const,
    // Reasoning precedes the prose, so only the reasoning part carries cache `response` data.
    content: [
      { type: "thinking" as const, thinking: "Checking sessions." },
      { type: "text" as const, text },
    ],
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "fixture",
    timestamp,
    stopReason: "stop" as const,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const entry = (id: string, message: { timestamp: number } & Record<string, unknown>) =>
    ({
      type: "message",
      id,
      parentId: null,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    }) as Parameters<typeof projectSessionEntries>[0][number];
  const input = entry("2", { role: "user", content: "What is running right now", timestamp: now });
  const answer = entry("3", reply("Two sessions are running.", now + 1));
  // Durable publishes whole snapshots; a fast reply may never appear as a live preview.
  f.publish(projectSessionEntries([input, answer]));
  await waitFor(() => expect(f.synthesize).toHaveBeenCalledOnce());
  expect(f.synthesize.mock.calls[0]?.[0]).toEqual({ text: "Two sessions are running." });
  // An older page loaded above the current turn is history requested before entry.
  f.publish(
    projectSessionEntries([entry("1", reply("An older answer.", now - 60_000)), input, answer]),
  );
  await act(async () => {});
  expect(f.synthesize).toHaveBeenCalledOnce();
});

it("typed Cake Chat turns carry voice style only while voice mode is active", async () => {
  using f = cakeChatVoiceFixture();
  await f.enter();
  const input = screen.getByRole("combobox", { name: "Message Cake Chat" });
  await f.user.type(input, "Typed while talking");
  await f.user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
  expect(f.prompt.mock.calls[0]?.[0].responseMode).toBe("voice");
  await f.user.click(screen.getByRole("button", { name: "Exit conversation mode" }));
  await f.user.type(input, "Typed after");
  await f.user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(2));
  expect(f.prompt.mock.calls[1]?.[0].responseMode).toBe("text");
});

it("leaving Cake Chat for a Project Session exits voice mode and releases capture", async () => {
  using f = cakeChatVoiceFixture();
  await f.enter();
  act(() => f.root.navigationStore.selectProjectSession("project-one"));
  await waitFor(() => expect(f.root.conversationModeStore.phase).toBe("off"));
  expect(f.stopCapture).toHaveBeenCalled();
});

it("an unmaterialized Cake Chat keeps voice disabled until its first message starts it", () => {
  using f = cakeChatVoiceFixture({ materialized: false });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Enter conversation mode" }).disabled,
  ).toBe(true);
  expect(f.root.conversationModeStore.phase).toBe("off");
});
