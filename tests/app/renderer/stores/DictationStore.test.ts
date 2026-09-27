import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationAudio } from "../../../../src/domain/dictation/dictation-data";
import type { MicrophoneCapture } from "../../../../src/renderer/dictation/microphone";
import type {
  DictationStore,
  DictationTarget,
} from "../../../../src/renderer/stores/DictationStore";
import { createDictationStore, installedDictationState } from "../../../helpers/dictation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const stores: DictationStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store[Symbol.dispose]());
});
function fixture() {
  const requests: Array<{ audio: DictationAudio; reply: ReturnType<typeof deferred<string>> }> = [];
  const captures: Array<{ push(samples: Float32Array): void; stop: ReturnType<typeof vi.fn> }> = [];
  const store = createDictationStore(
    {
      transcribe: (audio) => {
        const reply = deferred<string>();
        requests.push({ audio, reply });
        return reply.promise;
      },
    },
    {
      open: async (push) => {
        const stop = vi.fn();
        captures.push({ push, stop });
        return {
          stop,
          finish: async () => {
            stop();
          },
        };
      },
    },
  );
  stores.push(store);
  store.applyState({ ...installedDictationState, status: "ready" });
  const target = (id: string): DictationTarget => ({ id, begin: vi.fn(), replace: vi.fn() });
  return { store, requests, captures, target };
}
const drain = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

describe("focus-driven dictation workflow", () => {
  it("does not capture while disabled; keeps Preparing until model AND microphone are ready", async () => {
    const model = deferred<void>();
    const microphone = deferred<MicrophoneCapture>();
    const open = vi.fn(() => microphone.promise);
    const store = createDictationStore({ prepare: () => model.promise }, { open });
    stores.push(store);
    store.applyState(installedDictationState);
    store.focus({ id: "chat", begin() {}, replace() {} });
    expect(open).not.toHaveBeenCalled();
    const enabling = store.setEnabled(true);
    expect(store.phase).toBe("preparing");
    model.resolve();
    await drain();
    expect(open).toHaveBeenCalledOnce();
    expect(store.phase).toBe("preparing");
    microphone.resolve({ stop() {}, finish: async () => {} });
    await enabling;
    expect(store.phase).toBe("listening");
  });

  it("bounds processed microphone peaks before sending PCM to the native engine", async () => {
    const { store, requests, captures, target } = fixture();
    store.focus(target("chat"));
    await store.setEnabled(true);
    const samples = new Float32Array(12_800);
    samples.set([1.5, -1.5, Number.POSITIVE_INFINITY, Number.NaN, 0.25]);
    captures[0]!.push(samples);
    const bytes = Uint8Array.from(atob(requests[0]!.audio.pcm), (character) =>
      character.charCodeAt(0),
    );
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3, 4].map((index) => view.getFloat32(index * 4, true))).toEqual([
      1, -1, 0, 0, 0.25,
    ]);
    requests[0]!.reply.resolve("");
    await drain();
  });

  it("inserts progressive results but discards the old tail on focus change", async () => {
    const { store, requests, captures, target } = fixture();
    const chat = target("chat"),
      annotation = target("annotation");
    store.focus(chat);
    await store.setEnabled(true);
    captures[0]!.push(new Float32Array(12_800));
    requests[0]!.reply.resolve("Keep this");
    await drain();
    expect(chat.replace).toHaveBeenLastCalledWith("Keep this");
    captures[0]!.push(new Float32Array(12_800));
    store.blur(chat.id);
    store.focus(annotation);
    await drain();
    requests[1]!.reply.resolve("Old unfinished tail");
    await drain();
    expect(chat.replace).toHaveBeenCalledTimes(1);
    expect(annotation.replace).not.toHaveBeenCalled();
    expect(captures[0]!.stop).toHaveBeenCalled();
    captures[1]!.push(new Float32Array(12_800));
    requests[2]!.reply.resolve("New annotation");
    await drain();
    expect(annotation.replace).toHaveBeenCalledWith("New annotation");
    expect(requests[2]!.audio.utteranceId).not.toBe(requests[0]!.audio.utteranceId);
  });

  it("Enter drains an in-flight chunk and final audio before allowing exactly one submission", async () => {
    const { store, requests, captures, target } = fixture();
    const chat = target("chat");
    store.focus(chat);
    await store.setEnabled(true);
    captures[0]!.push(new Float32Array(12_800));
    captures[0]!.push(new Float32Array(3200));
    const finishing = store.finish(chat.id);
    expect(store.phase).toBe("finishing");
    expect(await store.finish(chat.id)).toBe(false);
    requests[0]!.reply.resolve("Beginning");
    await drain();
    expect(requests[1]!.audio.final).toBe(true);
    expect(requests[1]!.audio.pcm.length).toBeGreaterThan(0);
    requests[1]!.reply.resolve("Beginning and last words");
    expect(await finishing).toBe(true);
    expect(chat.replace).toHaveBeenLastCalledWith("Beginning and last words");
    expect(store.phase).toBe("paused");
  });

  it("focus loss during Enter cancels submission and never changes either draft", async () => {
    const { store, requests, target } = fixture();
    const chat = target("chat");
    store.focus(chat);
    await store.setEnabled(true);
    const finishing = store.finish(chat.id);
    await drain();
    store.blur(chat.id);
    requests[0]!.reply.resolve("Do not send");
    expect(await finishing).toBe(false);
    expect(chat.replace).not.toHaveBeenCalled();
  });

  it("a microphone that opens after blur is immediately stopped", async () => {
    const microphone = deferred<MicrophoneCapture>();
    const stop = vi.fn();
    const store = createDictationStore({}, { open: () => microphone.promise });
    stores.push(store);
    store.applyState({ ...installedDictationState, status: "ready" });
    store.focus({ id: "chat", begin() {}, replace() {} });
    const enabling = store.setEnabled(true);
    await drain();
    store.blur("chat");
    microphone.resolve({ stop, finish: async () => {} });
    await enabling;
    expect(stop).toHaveBeenCalledOnce();
    expect(store.phase).toBe("paused");
  });

  it("manual edits seal visible text and invalidate pending recognition", async () => {
    const { store, requests, captures, target } = fixture();
    const chat = target("chat");
    store.focus(chat);
    await store.setEnabled(true);
    captures[0]!.push(new Float32Array(12_800));
    store.restart(chat.id);
    requests[0]!.reply.resolve("Must not overwrite typing");
    await drain();
    expect(chat.replace).not.toHaveBeenCalled();
    expect(chat.begin).toHaveBeenCalledTimes(2);
    expect(captures).toHaveLength(1);
    expect(captures[0]!.stop).not.toHaveBeenCalled();
    expect(store.phase).toBe("listening");
    captures[0]!.push(new Float32Array(12_800));
    expect(requests[1]!.audio.utteranceId).not.toBe(requests[0]!.audio.utteranceId);
    requests[1]!.reply.resolve("Speech after typing");
    await drain();
    expect(chat.replace).toHaveBeenCalledWith("Speech after typing");
  });

  it("switching fields during model warmup keeps Preparing and starts only the latest field", async () => {
    const warmup = deferred<void>();
    const open = vi.fn(async () => ({ stop() {}, finish: async () => {} }));
    const store = createDictationStore({ prepare: () => warmup.promise }, { open });
    stores.push(store);
    store.applyState({ ...installedDictationState, status: "loading" });
    store.focus({ id: "chat", begin() {}, replace() {} });
    const enabling = store.setEnabled(true);
    store.blur("chat");
    const annotation = { id: "annotation", begin: vi.fn(), replace: vi.fn() };
    store.focus(annotation);
    expect(store.phase).toBe("preparing");
    expect(open).not.toHaveBeenCalled();
    warmup.resolve();
    await enabling;
    expect(annotation.begin).toHaveBeenCalledOnce();
    expect(store.phase).toBe("listening");
  });

  it("a recognition failure is visible, stops capture, and does not authorize submission", async () => {
    const { store, requests, captures, target } = fixture();
    const chat = target("chat");
    store.focus(chat);
    await store.setEnabled(true);
    const finishing = store.finish(chat.id);
    await drain();
    requests[0]!.reply.reject(new Error("Engine stopped"));
    expect(await finishing).toBe(false);
    expect(store.phase).toBe("error");
    expect(store.error).toBe("Engine stopped");
    expect(captures[0]!.stop).toHaveBeenCalled();
  });
});
