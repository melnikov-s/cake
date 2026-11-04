import type { SpeechOutputAudio } from "../../contracts/speech/speech-output-data";
import type { SpeechOutputCommands } from "../client/Client";
import type { PausableSpeechPlayback } from "./playback";

/** Provider requests accept at most this many characters. */
const MAX_CHUNK_CHARACTERS = 2_000;
/** Chunks synthesized ahead of the one being scheduled, hiding provider latency. */
const LOOKAHEAD_CHUNKS = 2;

/** One provider request, with its position in the widget's original text. */
export interface WidgetSpeechChunk {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

type WidgetSpeechStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

/** What a widget sees: which chunk is audible and where it sits in the text it supplied. */
export interface WidgetSpeechState {
  readonly id: string | null;
  readonly status: WidgetSpeechStatus;
  readonly chunk: number;
  readonly chunks: number;
  readonly start: number;
  readonly end: number;
  readonly error: string | null;
}

const idleWidgetSpeechState: WidgetSpeechState = {
  id: null,
  status: "idle",
  chunk: 0,
  chunks: 0,
  start: 0,
  end: 0,
  error: null,
};

interface WidgetSpeechRequest {
  readonly id: string;
  readonly text: string;
  /** Chunk index to start from, for sentence skip and restart. */
  readonly from?: number;
}

export interface WidgetSpeechDependencies {
  readonly synthesize: SpeechOutputCommands["synthesize"];
  readonly createPlayback: () => PausableSpeechPlayback;
}

export interface WidgetSpeech {
  speak(
    owner: string,
    request: WidgetSpeechRequest,
    listener: (state: WidgetSpeechState) => void,
  ): void;
  pause(owner: string): void;
  resume(owner: string): void;
  stop(owner: string): void;
  /** Stops without notifying: the owner's frame is gone. */
  release(owner: string): void;
}

/** Sentence- and line-bounded chunks no longer than one provider request. */
export function chunkSpeechText(
  text: string,
  maxCharacters = MAX_CHUNK_CHARACTERS,
): WidgetSpeechChunk[] {
  const chunks: WidgetSpeechChunk[] = [];
  const push = (start: number, end: number) => {
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    while (end - start > maxCharacters) {
      const window = text.slice(start, start + maxCharacters + 1);
      const space = window.search(/\s\S*$/);
      const cut = space > 0 ? start + space : start + maxCharacters;
      push(start, cut);
      start = cut;
      while (start < end && /\s/.test(text[start]!)) start++;
    }
    if (end > start) chunks.push({ text: text.slice(start, end), start, end });
  };
  let start = 0;
  for (const match of text.matchAll(/[.!?…]+["'”’)\]]*(?=\s|$)|\n/g)) {
    const end = match.index + match[0].length;
    push(start, end);
    start = end;
  }
  push(start, text.length);
  return chunks;
}

/** One widget at a time reads through its own playback, separate from voice mode. */
export function createWidgetSpeech(dependencies: WidgetSpeechDependencies): WidgetSpeech {
  let active:
    | {
        owner: string;
        controller: AbortController;
        playback: PausableSpeechPlayback;
        paused: boolean;
        report(): void;
        notify(): void;
      }
    | undefined;

  const abort = (owner: string, notify: boolean) => {
    const current = active;
    if (!current || current.owner !== owner) return;
    active = undefined;
    current.controller.abort();
    current.playback.stop();
    if (notify) current.notify();
  };

  return {
    speak(owner, request, listener) {
      if (active) abort(active.owner, true);
      const chunks = chunkSpeechText(request.text);
      if (!chunks.length) {
        listener({
          ...idleWidgetSpeechState,
          id: request.id,
          status: "error",
          error: "Nothing to read: the text is empty.",
        });
        return;
      }
      const from = Math.min(request.from ?? 0, chunks.length - 1);
      const controller = new AbortController();
      const signal = controller.signal;
      const playback = dependencies.createPlayback();
      let phase: "loading" | "playing" = "loading";
      let chunk = from;
      const session = {
        owner,
        controller,
        playback,
        paused: false,
        report: () => emit({}),
        notify: () => listener({ ...idleWidgetSpeechState, id: request.id }),
      };
      const emit = (state: Partial<WidgetSpeechState>) =>
        listener({
          id: request.id,
          status: session.paused ? "paused" : phase,
          chunk,
          chunks: chunks.length,
          start: chunks[chunk]!.start,
          end: chunks[chunk]!.end,
          error: null,
          ...state,
        });
      active = session;

      // Producer/consumer hand-off. Synthesis never waits on playback, so a long
      // pause does not hold a provider stream open; it only stops looking ahead.
      const slots: Array<{ parts: SpeechOutputAudio[]; done: boolean; error?: unknown }> = [];
      let scheduling = from;
      let waiters: Array<() => void> = [];
      const changed = () => {
        const wake = waiters;
        waiters = [];
        for (const resolve of wake) resolve();
      };
      const nextChange = () =>
        new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      signal.addEventListener("abort", changed, { once: true });

      const produce = async () => {
        for (let index = from; index < chunks.length; index++) {
          while (index - scheduling > LOOKAHEAD_CHUNKS && !signal.aborted) await nextChange();
          if (signal.aborted) return;
          const slot: (typeof slots)[number] = { parts: [], done: false };
          slots[index] = slot;
          try {
            await dependencies.synthesize(
              { text: chunks[index]!.text },
              async (audio) => {
                slot.parts.push(audio);
                changed();
              },
              { signal },
            );
          } catch (error) {
            slot.error = error;
            return;
          } finally {
            slot.done = true;
            changed();
          }
        }
      };

      const consume = async () => {
        emit({});
        await playback.start(signal);
        if (session.paused) await playback.pause();
        for (let index = from; index < chunks.length; index++) {
          scheduling = index;
          changed();
          let scheduled = 0;
          for (;;) {
            signal.throwIfAborted();
            const slot = slots[index];
            const audio = slot?.parts.shift();
            if (audio) {
              if (!scheduled)
                playback.mark(() => {
                  if (signal.aborted) return;
                  phase = "playing";
                  chunk = index;
                  emit({});
                });
              scheduled++;
              await playback.enqueue(audio, signal);
            } else if (slot?.error !== undefined) throw slot.error;
            else if (slot?.done) {
              if (!scheduled) throw new Error("The speech provider returned no audio.");
              break;
            } else await nextChange();
          }
        }
        await playback.drain(signal);
      };

      void produce();
      consume().then(
        () => {
          if (signal.aborted) return;
          active = undefined;
          controller.abort();
          playback.stop();
          chunk = chunks.length - 1;
          emit({ status: "ended" });
        },
        (error: unknown) => {
          if (signal.aborted) return;
          active = undefined;
          controller.abort();
          playback.stop();
          emit({ status: "error", error: error instanceof Error ? error.message : String(error) });
        },
      );
    },
    pause(owner) {
      if (active?.owner !== owner || active.paused) return;
      active.paused = true;
      active.report();
      void active.playback.pause().catch(() => undefined);
    },
    resume(owner) {
      if (active?.owner !== owner || !active.paused) return;
      active.paused = false;
      active.report();
      void active.playback.resume().catch(() => undefined);
    },
    stop(owner) {
      abort(owner, true);
    },
    release(owner) {
      abort(owner, false);
    },
  };
}
