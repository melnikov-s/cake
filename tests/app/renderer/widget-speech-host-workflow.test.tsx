/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../src/contracts/artifacts/artifact-contract";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import type { Client } from "../../../src/renderer/client/Client";
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import { WidgetArtifact } from "../../../src/renderer/components/widget-artifact";
import type { InlineWidgetStore } from "../../../src/renderer/stores/InlineWidgetStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const token = "00000000-0000-4000-8000-000000000020";
const lineageId = decodeArtifactLineageId("reader");
const record: ArtifactRecord = {
  artifact: {
    protocol: "cake.artifact/v1",
    id: lineageId,
    sessionId: "author",
    revision: 1,
    kind: "widget",
    payload: {
      language: "html",
      source: "<p>Reader</p>",
      brief: "Reader",
      generationSessionId: "private",
      browser: { digest: "c".repeat(64) },
    },
    fallback: { markdown: "Reader fallback" },
  },
  workspacePath: "/project",
  digest: "d".repeat(64),
  createdAt: "",
  updatedAt: "",
};
/** Web Audio stand-in: every scheduled buffer finishes on the next timer turn. */
function stubAudio() {
  const contexts: Array<{ state: AudioContextState; suspend: ReturnType<typeof vi.fn> }> = [];
  class Context {
    state: AudioContextState = "suspended";
    currentTime = 0;
    destination = {};
    onstatechange: (() => void) | null = null;
    constructor() {
      contexts.push(this);
    }
    resume = vi.fn(async () => {
      this.state = "running";
    });
    suspend = vi.fn(async () => {
      this.state = "suspended";
    });
    close = vi.fn(async () => {
      this.state = "closed";
    });
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
    createBufferSource() {
      const node = {
        buffer: undefined as unknown,
        onended: undefined as undefined | (() => void),
        connect: vi.fn(),
        disconnect: vi.fn(),
        stop: vi.fn(),
        start: () => setTimeout(() => node.onended?.(), 0),
      };
      return node;
    }
  }
  vi.stubGlobal("AudioContext", Context);
  return contexts;
}

const silence = { encoding: "pcm_s16le", sampleRate: 24000, pcm: "AAAAAA==" } as const;

function hosts(): Array<[string, (store: InlineWidgetStore) => ReactElement]> {
  return [
    [
      "artifact widget",
      (store) => <ArtifactHost record={record} presentation="workspace" inlineWidgets={store} />,
    ],
    [
      "attached widget",
      (store) =>
        record.artifact.kind === "widget" ? (
          <WidgetArtifact
            artifact={record.artifact}
            inlineWidgets={store}
            viewSession={{ sessionId: "viewer", kind: "project-session" }}
          />
        ) : (
          <></>
        ),
    ],
  ];
}

function fixture(synthesize: Client["speechOutput"]["synthesize"]) {
  return createRendererStoreFixture({
    client: {
      inlineWidgets: {
        open: async () => ({ token, url: `cake-widget://document/${token}` }),
        compile: async () => ({ token, url: `cake-widget://document/${token}` }),
      },
      artifacts: {
        catalog: async () => ({ items: [], offset: 0, limit: 50, total: 0, hasMore: false }),
      },
      speechOutput: { synthesize },
    },
  });
}

const speechRequest = (frame: HTMLIFrameElement, value: object, requestToken = token) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { source: "cake-inline-widget", token: requestToken, type: "speech", value },
      }),
    );
  });

beforeEach(() => {
  stubAudio();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("widget speech host workflow", () => {
  it.each(hosts())(
    "reads %s text aloud through the configured voice and reports progress to its frame",
    async (_name, element) => {
      const synthesize = vi.fn<Client["speechOutput"]["synthesize"]>(async (_request, consume) => {
        await consume(silence);
      });
      using test = fixture(synthesize);
      const view = render(element(test.root.inlineWidgetStore));
      await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
      const frame = view.container.querySelector("iframe")!;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      speechRequest(frame, { action: "speak", id: "7", text: "Ignored." }, "other-token");
      speechRequest(frame, { action: "speak", id: "7", text: "First sentence. Second one." });
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          {
            source: "cake-widget-host",
            token,
            type: "speech-state",
            value: {
              id: "7",
              status: "ended",
              chunk: 1,
              chunks: 2,
              start: 16,
              end: 27,
              error: null,
            },
          },
          "*",
        ),
      );
      expect(synthesize.mock.calls.map(([request]) => request.text)).toEqual([
        "First sentence.",
        "Second one.",
      ]);
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.objectContaining({ status: "playing", chunk: 0 }),
        }),
        "*",
      );
      view.unmount();
    },
  );

  it.each(hosts())("stops %s speech when the widget unmounts", async (_name, element) => {
    const signals: AbortSignal[] = [];
    const synthesize = vi.fn<Client["speechOutput"]["synthesize"]>(
      (_request, _consume, options) =>
        new Promise((_resolve, reject) => {
          signals.push(options!.signal!);
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason));
        }),
    );
    using test = fixture(synthesize);
    const view = render(element(test.root.inlineWidgetStore));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    speechRequest(frame, { action: "speak", id: "1", text: "A long article." });
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    view.unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it("forwards pause and resume to the speaking frame's playback", async () => {
    const contexts = stubAudio();
    let consume: ((audio: typeof silence) => Promise<void>) | undefined;
    const synthesize = vi.fn<Client["speechOutput"]["synthesize"]>(
      (_request, next, options) =>
        new Promise((_resolve, reject) => {
          consume = next;
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason));
        }),
    );
    using test = fixture(synthesize);
    const [, element] = hosts()[0]!;
    const view = render(element(test.root.inlineWidgetStore));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    speechRequest(frame, { action: "speak", id: "1", text: "Hello there." });
    await waitFor(() => expect(contexts[0]?.state).toBe("running"));
    speechRequest(frame, { action: "pause" });
    await waitFor(() => expect(contexts[0]!.suspend).toHaveBeenCalledOnce());
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: expect.objectContaining({ status: "paused" }) }),
      "*",
    );
    await act(() => consume!(silence));
    speechRequest(frame, { action: "resume" });
    await waitFor(() => expect(contexts[0]!.state).toBe("running"));
    speechRequest(frame, { action: "stop" });
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: expect.objectContaining({ status: "idle" }) }),
      "*",
    );
    view.unmount();
  });
});
