import { describe, expect, it, vi } from "vitest";
import type { SpeechOutputAudio } from "../../../src/contracts/speech/speech-output-data";
import type { PausableSpeechPlayback } from "../../../src/renderer/speech/playback";
import {
  chunkSpeechText,
  createWidgetSpeech,
  type WidgetSpeechDependencies,
  type WidgetSpeechState,
} from "../../../src/renderer/speech/widget-speech";

const pcm = (text: string): SpeechOutputAudio => ({
  encoding: "pcm_s16le",
  sampleRate: 24000,
  pcm: btoa(text.padEnd(4, " ").slice(0, 4)),
});

function fakePlayback(blocking = false) {
  const enqueued: string[] = [];
  let release: (() => void) | undefined;
  const playback = {
    enqueued,
    /** When set, enqueue waits until `flush` is called, like a full five-second window. */
    blocking,
    flush: () => release?.(),
    start: vi.fn(async () => {}),
    enqueue: vi.fn(async (audio: SpeechOutputAudio) => {
      enqueued.push(atob(audio.pcm));
      if (playback.blocking)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }),
    drain: vi.fn(async () => {}),
    mark: vi.fn((callback: () => void) => callback()),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  return playback satisfies PausableSpeechPlayback;
}

function harness(synthesize?: WidgetSpeechDependencies["synthesize"], blocking = false) {
  const playbacks: ReturnType<typeof fakePlayback>[] = [];
  const requests: string[] = [];
  const signals: AbortSignal[] = [];
  const speech = createWidgetSpeech({
    synthesize:
      synthesize ??
      (async (request, consume, options) => {
        requests.push(request.text);
        if (options?.signal) signals.push(options.signal);
        await consume(pcm(request.text));
      }),
    createPlayback: () => {
      const playback = fakePlayback(blocking);
      playbacks.push(playback);
      return playback;
    },
  });
  return { speech, playbacks, requests, signals };
}

const listen = () => {
  const states: WidgetSpeechState[] = [];
  const listener = vi.fn((state: WidgetSpeechState) => states.push(state));
  const settled = () =>
    vi.waitFor(() =>
      expect(["ended", "error", "idle"]).toContain(states[states.length - 1]?.status),
    );
  return { states, listener, settled };
};

describe("widget speech chunking", () => {
  it("splits at sentence ends and line breaks, keeping offsets into the original text", () => {
    const text = "  Hello there. How are you?\nFine!  Thanks…\n\n";
    const chunks = chunkSpeechText(text);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Hello there.",
      "How are you?",
      "Fine!",
      "Thanks…",
    ]);
    for (const chunk of chunks) expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
  });

  it("keeps every chunk within one provider request, preferring word boundaries", () => {
    const words = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
    const chunks = chunkSpeechText(words);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 2000)).toBe(true);
    expect(chunks.every((chunk) => /^word\d+$/.test(chunk.text.split(" ").at(-1)!))).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(words);
    expect(chunkSpeechText("x".repeat(4500)).map((chunk) => chunk.text.length)).toEqual([
      2000, 2000, 500,
    ]);
    expect(chunkSpeechText(" \n ")).toEqual([]);
  });
});

describe("widget speech reader", () => {
  it("synthesizes each chunk in order and reports the audible chunk until it ends", async () => {
    const { speech, playbacks, requests } = harness();
    const { states, listener, settled } = listen();
    speech.speak("frame", { id: "1", text: "One. Two. Three." }, listener);
    await settled();
    expect(requests).toEqual(["One.", "Two.", "Three."]);
    expect(playbacks[0]!.enqueued.map((value) => value.trim())).toEqual(["One.", "Two.", "Thre"]);
    expect(states.map(({ status, chunk, start, end }) => [status, chunk, start, end])).toEqual([
      ["loading", 0, 0, 4],
      ["playing", 0, 0, 4],
      ["playing", 1, 5, 9],
      ["playing", 2, 10, 16],
      ["ended", 2, 10, 16],
    ]);
    expect(states.every((state) => state.chunks === 3 && state.id === "1")).toBe(true);
    expect(playbacks[0]!.stop).toHaveBeenCalled();
  });

  it("starts from a requested chunk for skip and restart", async () => {
    const { speech, requests } = harness();
    const { states, listener, settled } = listen();
    speech.speak("frame", { id: "1", text: "One. Two. Three.", from: 1 }, listener);
    await settled();
    expect(requests).toEqual(["Two.", "Three."]);
    expect(states[0]).toMatchObject({ status: "loading", chunk: 1 });
  });

  it("looks ahead a bounded number of chunks while playback is busy", async () => {
    const { speech, playbacks, requests } = harness(undefined, true);
    const { listener } = listen();
    speech.speak("frame", { id: "1", text: "A. B. C. D. E. F. G." }, listener);
    await vi.waitFor(() => expect(playbacks[0]!.enqueue).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(requests.length).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toEqual(["A.", "B.", "C."]);
    playbacks[0]!.flush();
    await vi.waitFor(() => expect(requests).toEqual(["A.", "B.", "C.", "D."]));
    speech.stop("frame");
  });

  it("pauses and resumes the playback clock and reports it", async () => {
    const { speech, playbacks } = harness();
    const { states, listener, settled } = listen();
    speech.speak("frame", { id: "1", text: "One. Two." }, listener);
    await vi.waitFor(() => expect(playbacks[0]).toBeDefined());
    playbacks[0]!.blocking = true;
    await vi.waitFor(() => expect(playbacks[0]!.enqueue).toHaveBeenCalled());
    speech.pause("frame");
    expect(playbacks[0]!.pause).toHaveBeenCalledOnce();
    expect(states.at(-1)?.status).toBe("paused");
    speech.pause("frame");
    expect(playbacks[0]!.pause).toHaveBeenCalledOnce();
    speech.resume("frame");
    expect(playbacks[0]!.resume).toHaveBeenCalledOnce();
    expect(states.at(-1)?.status).toBe("playing");
    playbacks[0]!.blocking = false;
    playbacks[0]!.flush();
    await settled();
    expect(states.at(-1)?.status).toBe("ended");
  });

  it("surfaces provider errors such as unconfigured speech output", async () => {
    const { speech, playbacks } = harness(async () => {
      throw new Error(
        "Configure an ElevenLabs API key and select a voice in Speech output settings.",
      );
    });
    const { states, listener, settled } = listen();
    speech.speak("frame", { id: "1", text: "Hello." }, listener);
    await settled();
    expect(states.at(-1)).toMatchObject({
      status: "error",
      error: "Configure an ElevenLabs API key and select a voice in Speech output settings.",
    });
    expect(playbacks[0]!.stop).toHaveBeenCalled();
  });

  it("reports empty text instead of silently doing nothing", () => {
    const { speech, playbacks } = harness();
    const { states, listener } = listen();
    speech.speak("frame", { id: "1", text: "   " }, listener);
    expect(states).toEqual([expect.objectContaining({ status: "error", chunks: 0 })]);
    expect(playbacks).toHaveLength(0);
  });

  it("lets one widget speak at a time: a new speaker stops and notifies the previous one", async () => {
    const { speech, playbacks, signals } = harness();
    const first = listen();
    const second = listen();
    speech.speak("a", { id: "1", text: "One. Two." }, first.listener);
    await vi.waitFor(() => expect(playbacks[0]).toBeDefined());
    playbacks[0]!.blocking = true;
    await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
    speech.speak("b", { id: "1", text: "Three." }, second.listener);
    expect(first.states.at(-1)).toMatchObject({ id: "1", status: "idle" });
    expect(playbacks[0]!.stop).toHaveBeenCalled();
    expect(signals[0]!.aborted).toBe(true);
    await second.settled();
    expect(second.states.at(-1)?.status).toBe("ended");
    speech.pause("a");
    expect(playbacks[1]!.pause).not.toHaveBeenCalled();
  });

  it("stop notifies the owner and release (unmount) stops silently", async () => {
    const { speech, playbacks, signals } = harness();
    const stopped = listen();
    speech.speak("frame", { id: "1", text: "One. Two." }, stopped.listener);
    await vi.waitFor(() => expect(playbacks[0]).toBeDefined());
    playbacks[0]!.blocking = true;
    await vi.waitFor(() => expect(playbacks[0]!.enqueue).toHaveBeenCalled());
    speech.stop("frame");
    expect(stopped.states.at(-1)?.status).toBe("idle");
    expect(playbacks[0]!.stop).toHaveBeenCalled();

    const released = listen();
    speech.speak("frame", { id: "2", text: "One. Two." }, released.listener);
    await vi.waitFor(() => expect(playbacks[1]).toBeDefined());
    playbacks[1]!.blocking = true;
    await vi.waitFor(() => expect(playbacks[1]!.enqueue).toHaveBeenCalled());
    const before = released.states.length;
    speech.release("frame");
    expect(released.states).toHaveLength(before);
    expect(playbacks[1]!.stop).toHaveBeenCalled();
    expect(signals.at(-1)!.aborted).toBe(true);
  });
});
