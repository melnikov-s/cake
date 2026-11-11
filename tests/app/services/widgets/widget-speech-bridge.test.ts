import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  compileInlineWidget,
  type InlineWidgetCapability,
} from "../../../../src/services/widgets/inline-widget-service";

interface SpeechApi {
  speak(text: string, options?: { from?: number }): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  getSnapshot(): { id: string | null; status: string; chunk: number; error: string | null };
  subscribe(listener: () => void): () => void;
}

interface BridgeWindow extends Window {
  ResizeObserver: unknown;
  MessageEvent: typeof MessageEvent;
}
// jsdom ships no type declarations; this test needs only the constructor and its window.
// SAFETY: the shape below is jsdom's documented public API.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options: { runScripts: "dangerously"; beforeParse(window: BridgeWindow): void },
  ) => { window: BridgeWindow };
};

/** Runs the compiled document's real bridge script; the test plays the parent host. */
async function runBridge(capability: InlineWidgetCapability) {
  const compiled = await compileInlineWidget("html", "<p>Article</p>", capability);
  const sent: Array<{ source: string; token: string; type: string; value: unknown }> = [];
  const { window } = new JSDOM(compiled.document, {
    runScripts: "dangerously",
    beforeParse(window) {
      // A top-level document is its own parent: capture what the frame sends upward.
      window.postMessage = (data: (typeof sent)[number]) => {
        if (data?.type === "speech") sent.push(data);
      };
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      };
    },
  });
  const host = (value: object, token = compiled.token) =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: { source: "cake-widget-host", token, type: "speech-state", value },
      }),
    );
  const speech = Reflect.get(window, "cakeSpeech") as SpeechApi | undefined;
  return {
    speech,
    sent: () => sent,
    host,
    token: compiled.token,
    [Symbol.dispose]: () => window.close(),
  };
}

const state = (id: string, status: string, extra: object = {}) => ({
  id,
  status,
  chunk: 0,
  chunks: 2,
  start: 0,
  end: 4,
  error: null,
  ...extra,
});

describe("widget speech bridge", () => {
  it.each(["artifact"] as const)(
    "gives %s widgets cakeSpeech requests and host-driven progress",
    async (capability) => {
      using bridge = await runBridge(capability);
      const { speech, sent, host, token } = bridge;
      expect(speech).toBeDefined();
      const spoken = speech!.speak("One. Two.", { from: 1 });
      speech!.pause();
      speech!.resume();
      speech!.stop();
      expect(sent()).toEqual([
        {
          source: "cake-inline-widget",
          token,
          type: "speech",
          value: { action: "speak", id: "1", text: "One. Two.", from: 1 },
        },
        { source: "cake-inline-widget", token, type: "speech", value: { action: "pause" } },
        { source: "cake-inline-widget", token, type: "speech", value: { action: "resume" } },
        { source: "cake-inline-widget", token, type: "speech", value: { action: "stop" } },
      ]);
      let updates = 0;
      speech!.subscribe(() => updates++);
      host(state("1", "playing", { chunk: 1 }), "wrong-token");
      expect(speech!.getSnapshot().status).toBe("idle");
      host(state("1", "playing", { chunk: 1 }));
      expect(speech!.getSnapshot()).toMatchObject({ status: "playing", chunk: 1 });
      host(state("1", "ended", { chunk: 1 }));
      await expect(spoken).resolves.toBeUndefined();
      expect(updates).toBe(2);
    },
  );

  it("rejects on host errors and settles a superseded utterance without disturbing the newer one", async () => {
    using bridge = await runBridge("artifact");
    const { speech, host } = bridge;
    const first = speech!.speak("First.");
    const second = speech!.speak("Second.");
    host(state("1", "idle"));
    await expect(first).resolves.toBeUndefined();
    expect(speech!.getSnapshot().status).toBe("idle");
    host(state("2", "loading"));
    expect(speech!.getSnapshot()).toMatchObject({ id: "2", status: "loading" });
    host(state("2", "error", { error: "Download Pocket TTS in Settings → Speech output first." }));
    await expect(second).rejects.toThrow("Download Pocket TTS");
    expect(speech!.getSnapshot().error).toBe(
      "Download Pocket TTS in Settings → Speech output first.",
    );
    await expect(speech!.speak("x", { from: -1 })).rejects.toThrow("nonnegative integer");
  });

  it("does not give display or request widgets speech", async () => {
    for (const capability of ["display", "request"] as const) {
      using bridge = await runBridge(capability);
      expect(bridge.speech).toBeUndefined();
    }
  });

  it("bundles useSpeech in the unified widget SDK", async () => {
    for (const [capability, sdk] of [["artifact", "@cake/artifact-sdk"]] as const) {
      const compiled = await compileInlineWidget(
        "react",
        `import { useSpeech } from "${sdk}"; export default function Reader() { const speech = useSpeech(); return <button onClick={() => speech.status === "playing" ? speech.pause() : speech.speak("Hello.")}>{speech.status}</button>; }`,
        capability,
      );
      expect(compiled.document).toContain("globalThis.cakeSpeech");
    }
  });
});
