import { Effect, Stream } from "effect";
import { RpcSchema } from "effect/unstable/rpc";
import type {
  FromClientEncoded,
  FromServerEncoded,
  RequestEncoded,
} from "effect/unstable/rpc/RpcMessage";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CakeClientRpc,
  CakeIpcClient,
  type CakeIpcClientService,
} from "../../../src/ipc/client/CakeIpcClient";
import { makeClient } from "../../../src/renderer/client/ClientLive";
import { makeRuntime } from "../../../src/renderer/runtime";
import type { Client } from "../../../src/renderer/client/Client";
import type { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { ClientError } from "../../../src/renderer/client/Client";

function harness(
  onRequest: (message: RequestEncoded, respond: (message: FromServerEncoded) => void) => void,
) {
  const messages: FromClientEncoded[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const interrupted = Promise.withResolvers<void>();
  const runtime = makeRuntime({
    send(message) {
      messages.push(message);
      if (message._tag === "Interrupt") interrupted.resolve();
      if (message._tag !== "Request") return;
      const respond = (response: FromServerEncoded) => {
        for (const listener of listeners) listener(response);
      };
      // The runtime owns this permanent presentation observer. Let it finish
      // without a theme update rather than substituting a fake runtime.
      if (message.tag === "vscodeViews.observeThemes") {
        respond({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: null } });
      } else onRequest(message, respond);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return { runtime, client: makeClient(runtime), messages, interrupted };
}

const requests = (messages: FromClientEncoded[]) =>
  messages.filter(
    (message): message is RequestEncoded =>
      message._tag === "Request" && message.tag !== "vscodeViews.observeThemes",
  );

const presetId = "00000000-0000-4000-8000-000000000001";

describe("generated renderer command adaptation", () => {
  it.each([
    {
      _tag: "ResolutionRejected",
      operation: "resolve",
      sessionIds: ["child"],
      message: "Resolve the root instead",
    },
    {
      _tag: "ResolutionCleanupFailed",
      operation: "resolve",
      resolvedSessionIds: ["root", "child"],
      cleanupFailures: [{ workingDirectory: "/child-tree", message: "Checkout busy" }],
      message: "Resolution committed; cleanup failed",
    },
  ])(
    "preserves $_tag identities and details through encoded RPC and the real Client",
    async (failure) => {
      // Fork's existing resolveSource path invokes the same lifecycle operation.
      for (const action of ["resolve", "fork"] as const) {
        const test = harness((message, respond) =>
          respond({
            _tag: "Exit",
            requestId: message.id,
            exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: failure }] },
          }),
        );
        try {
          const result =
            action === "resolve"
              ? test.client.projectSessions.resolve({ sessionId: "root" })
              : test.client.projectSessions.fork({
                  sessionId: "root",
                  entryId: "entry",
                  resolveSource: true,
                });
          await expect(result).rejects.toMatchObject({
            kind: "rejected",
            operation: `projectSessions.${action}`,
            domainFailure: failure,
          });
          expect(requests(test.messages)).toHaveLength(1);
        } finally {
          await test.runtime.dispose();
        }
      }
    },
  );

  it("decodes committed IDs and both batch failure lists", async () => {
    const result = {
      projectPath: "/project",
      workingDirectory: "/tree",
      resolvedSessionIds: ["done"],
      failures: [{ sessionIds: ["busy"], message: "Turn active" }],
      cleanupFailures: [
        {
          _tag: "ResolutionCleanupFailed",
          operation: "resolveWorkingDirectory",
          resolvedSessionIds: ["done"],
          cleanupFailures: [{ workingDirectory: "/tree", message: "Busy" }],
          message: "Resolved with cleanup failure",
        },
      ],
    };
    const test = harness((message, respond) =>
      respond({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: result } }),
    );
    try {
      expect(
        await test.client.projectSessions.resolveWorkingDirectory({ workingDirectory: "/tree" }),
      ).toMatchObject(result);
      expect(requests(test.messages)).toHaveLength(1);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("derives every transport method, including Streams, from the shared protocol", async () => {
    const test = harness(() => {
      throw new Error("Assembly must not dispatch a command");
    });
    try {
      const service = await test.runtime.execute(Effect.service(CakeIpcClient));
      for (const rpc of CakeClientRpc.requests.values()) {
        const [group, name] = rpc._tag.split(".");
        const methods = Object.entries(service).find(([key]) => key === group)?.[1];
        expect(methods, rpc._tag).toBeDefined();
        expect(
          Object.entries(methods ?? {}).find(([key]) => key === name)?.[1],
          rpc._tag,
        ).toBeTypeOf("function");
      }
      expect(Stream.isStream(service.foundation.stream({ count: 2, intervalMs: 1 }))).toBe(true);
      // Commands and observations are different paths even though they share a
      // protocol group. Synthesis is the one explicit command Stream consumer.
      const expected = [...CakeClientRpc.requests.values()]
        .filter(
          (rpc) =>
            rpc._tag.startsWith("speechOutput.") && !RpcSchema.isStreamSchema(rpc.successSchema),
        )
        .map((rpc) => rpc._tag.slice("speechOutput.".length));
      expect(Object.keys(test.client.speechOutput).sort()).toEqual(
        [...expected, "synthesize"].sort(),
      );
      expect(requests(test.messages)).toEqual([]);
      expectTypeOf<Parameters<Client["speechOutput"]["setSpeed"]>[0]>().toEqualTypeOf<
        Parameters<CakeIpcClientService["speechOutput"]["setSpeed"]>[0]
      >();
      expectTypeOf<Awaited<ReturnType<Client["sessionChats"]["prompt"]>>>().toEqualTypeOf<TurnId>();
    } finally {
      await test.runtime.dispose();
    }
  });

  it("encodes zero, scalar, optional, multiple and object arguments without sending command options", async () => {
    const test = harness((message, respond) => {
      const value =
        message.tag === "modelPresets.setDefault"
          ? { presets: [] }
          : message.tag === "application.getHomeDirectory"
            ? "/home/test"
            : message.tag === "savedDrafts.list"
              ? []
              : null;
      respond({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value } });
    });
    const options = { signal: new AbortController().signal };
    try {
      expect(await test.client.application.getHomeDirectory(options)).toBe("/home/test");
      await test.client.speechOutput.installLocal(options);
      expect(await test.client.savedDrafts.list(options)).toEqual([]);
      await test.client.speechOutput.setSpeed(1.1, options);
      await test.client.modelPresets.setDefault(undefined, options);
      await test.client.modelPresets.setDefault(presetId, options);
      await test.client.savedDrafts.remove(presetId, 7, options);
      await test.client.projectSessions.respondControl(
        "session",
        presetId,
        { accepted: true },
        options,
      );
      await test.client.sessionChats.abort({ sessionId: "session", stop: { by: "user" } }, options);
      expect(requests(test.messages).map(({ tag, payload }) => ({ tag, payload }))).toEqual([
        { tag: "application.getHomeDirectory", payload: null },
        { tag: "speechOutput.installLocal", payload: null },
        { tag: "savedDrafts.list", payload: {} },
        { tag: "speechOutput.setSpeed", payload: { speed: 1.1 } },
        { tag: "modelPresets.setDefault", payload: { id: null } },
        { tag: "modelPresets.setDefault", payload: { id: presetId } },
        { tag: "savedDrafts.remove", payload: { sessionId: presetId, expectedRevision: 7 } },
        {
          tag: "projectSessions.respondControl",
          payload: { sessionId: "session", controlRequestId: presetId, result: { accepted: true } },
        },
        { tag: "sessionChats.abort", payload: { sessionId: "session", stop: { by: "user" } } },
      ]);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("rejects invalid payloads before dispatch while valid calls still execute", async () => {
    const test = harness((message, respond) => {
      respond({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: null } });
    });
    try {
      await expect(test.client.speechOutput.setSpeed(9)).rejects.toBeInstanceOf(ClientError);
      expect(requests(test.messages)).toEqual([]);
      await test.client.speechOutput.setSpeed(1.2);
      expect(requests(test.messages)).toHaveLength(1);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("translates schema-decoded typed failures without replaying the command", async () => {
    const test = harness((message, respond) => {
      respond({
        _tag: "Exit",
        requestId: message.id,
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: {
                _tag: "SpeechOutputError",
                kind: "storage",
                message: "Cannot save settings",
              },
            },
          ],
        },
      });
    });
    try {
      await expect(test.client.speechOutput.setSpeed(1.1)).rejects.toMatchObject({
        kind: "rejected",
        operation: "speechOutput.setSpeed",
        message: "Cannot save settings",
      });
      expect(requests(test.messages)).toHaveLength(1);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("forwards AbortSignal through a generated zero-payload command to RPC interruption", async () => {
    const started = Promise.withResolvers<void>();
    const test = harness(() => started.resolve());
    const controller = new AbortController();
    try {
      const pending = test.client.speechOutput.installLocal({ signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({
        kind: "interrupted",
        operation: "speechOutput.installLocal",
      });
      await started.promise;
      controller.abort();
      await rejected;
      await test.interrupted.promise;
      const request = requests(test.messages)[0];
      expect(test.messages).toContainEqual({ _tag: "Interrupt", requestId: request?.id });
      expect(requests(test.messages)).toHaveLength(1);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("retains remote attachment upload before dispatching a turn through its explicit adapter", async () => {
    const reference = `cake-upload:${presetId}`;
    const test = harness((message, respond) => {
      const value =
        message.tag === "attachmentUploads.open"
          ? { id: presetId }
          : message.tag === "attachmentUploads.finish"
            ? { reference }
            : message.tag === "sessionChats.prompt"
              ? presetId
              : null;
      respond({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value } });
    });
    const client = makeClient(test.runtime, {
      kind: "remote",
      connected: () => true,
      blocked: () => false,
      uncertain() {
        throw new Error("Successful admission must not be uncertain");
      },
    });
    try {
      expect(
        await client.sessionChats.prompt({
          sessionId: "session",
          text: "Review image",
          renderUserMessageAsMarkdown: false,
          attachments: [{ kind: "image", name: "image.png", mimeType: "image/png", data: "AAAA" }],
        }),
      ).toBe(presetId);
      const dispatched = requests(test.messages);
      expect(dispatched.map(({ tag }) => tag)).toEqual([
        "attachmentUploads.open",
        "attachmentUploads.chunk",
        "attachmentUploads.finish",
        "sessionChats.prompt",
      ]);
      expect(dispatched[0]?.payload).toEqual({
        kind: "image",
        name: "image.png",
        size: 3,
        mimeType: "image/png",
      });
      expect(dispatched[1]?.payload).toEqual({ id: presetId, offset: 0, data: "AAAA" });
      expect(dispatched[3]?.payload).toMatchObject({
        attachments: [{ kind: "image", name: "image.png", mimeType: "image/png", data: reference }],
      });
    } finally {
      await test.runtime.dispose();
    }
  });

  it("does not retry failed synthesis after delivering an audio chunk", async () => {
    const audio = { encoding: "pcm_s16le" as const, sampleRate: 24_000 as const, pcm: "AAAA" };
    const consumed: (typeof audio)[] = [];
    const test = harness((message, respond) => {
      respond({ _tag: "Chunk", requestId: message.id, values: [audio] });
      respond({
        _tag: "Exit",
        requestId: message.id,
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: {
                _tag: "SpeechOutputError",
                kind: "network",
                message: "Synthesis disconnected",
              },
            },
          ],
        },
      });
    });
    try {
      await expect(
        test.client.speechOutput.synthesize({ text: "Hello" }, async (chunk) => {
          consumed.push(chunk);
        }),
      ).rejects.toMatchObject({ kind: "rejected", operation: "speechOutput.synthesize" });
      expect(consumed).toEqual([audio]);
      expect(requests(test.messages)).toHaveLength(1);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("keeps one-shot synthesis on the ordered, non-retrying Stream consumer", async () => {
    const audio = { encoding: "pcm_s16le" as const, sampleRate: 24_000 as const, pcm: "AAAA" };
    const consumed: (typeof audio)[] = [];
    const test = harness((message, respond) => {
      respond({ _tag: "Chunk", requestId: message.id, values: [audio, audio] });
      respond({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: null } });
    });
    try {
      await test.client.speechOutput.synthesize({ text: "Hello" }, async (chunk) => {
        consumed.push(chunk);
      });
      expect(consumed).toEqual([audio, audio]);
      expect(requests(test.messages)).toHaveLength(1);
    } finally {
      await test.runtime.dispose();
    }
  });
});
