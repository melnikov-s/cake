import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSocket } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import {
  NetworkListenerError,
  openNetworkListener,
  type NetworkListenerOptions,
} from "../../src/server/NetworkListener";
import { ClientWorkspaces } from "../../src/services/clients/ClientWorkspaces";
import { RewordingRequests } from "../../src/services/projects/RewordingRequests";
import { ProjectAccess } from "../../src/services/projects/ProjectAccess";
import { RendererRequestCoordinator } from "../../src/services/renderer-requests/RendererRequestCoordinator";
import type { CakeEvent } from "../../src/ipc/cake-rpc-contract";
import type { Attachment } from "../../src/ipc/session-contract";
import { connectClient, rawClient } from "./fixtures/network-client";
import { cakeBuildId } from "../../src/ipc/protocol/BackendConnectionRpc";
import { generateReviewedWidget } from "../../src/domain/widgets/widgetGenerationReview";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { RemoteRenderedWidgetCaptureLive } from "../../src/services/widgets/RemoteRenderedWidgetCaptureLive";
import { RenderedWidgetCapture } from "../../src/services/widgets/RenderedWidgetCapture";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../../src/services/widgets/inline-widget-document-registry";
import { publishExtensionCompanionModule } from "../../src/services/pi/runtime/extension-companion-module-registry";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

const configuration = {
  homeDirectory: "/home/test",
  cakeChat: {
    agentDirectory: "/agent",
    location: cakeChatLocations.make({
      homeDirectory: "/home/test",
      sessionDirectory: "/chat",
      resolvedSessionDirectory: "/chat-resolved",
    }),
  },
};
const start = Effect.fn("NetworkTest.start")(function* (
  options: Partial<NetworkListenerOptions> = {},
  onPrompt?: (text: string, attachments: ReadonlyArray<Attachment>) => void,
) {
  const backend = yield* makeNetworkTestBackend(onPrompt ? { onPrompt } : undefined);
  const listener = yield* openNetworkListener(
    { port: 0, allowMissingOrigin: true, ...options },
    configuration,
  ).pipe(Effect.provideContext(backend.context));
  assert.equal(listener.address._tag, "TcpAddress");
  return { backend, listener, url: `ws://127.0.0.1:${listener.address.port}${listener.path}` };
});
const observe = Effect.fn("NetworkTest.observe")(function* (
  stream: Stream.Stream<CakeEvent, unknown>,
) {
  const events = yield* Queue.unbounded<CakeEvent>();
  const fiber = yield* stream.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  expect((yield* Queue.take(events)).type).toBe("renderer-events-ready");
  return { events, fiber };
});

it.live("network compiler publishes only live, capability-addressed rich content", () =>
  Effect.gen(function* () {
    const { listener, url } = yield* start();
    const { client } = yield* connectClient(url);
    const compiled = yield* client["widgets.compile-inline-widget"]({
      language: "react",
      capability: "display",
      source:
        "import React from 'react'; export default function App() { return <h1>Remote widget</h1> }",
    });
    const module = publishExtensionCompanionModule("export default 'remote companion'");
    const base = `http://127.0.0.1:${listener.address._tag === "TcpAddress" ? listener.address.port : 0}`;
    const document = `${base}/widget-assets/document/${compiled.widget.token}`;
    const source = `${base}/widget-assets/module/${module.token}`;
    const get = (path: string, init?: RequestInit) => Effect.promise(() => fetch(path, init));
    const served = yield* get(document);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(yield* Effect.promise(() => served.text())).toContain("Remote widget");
    const js = yield* get(source);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(yield* Effect.promise(() => js.text())).toContain("remote companion");
    expect((yield* get(`${base}/widget-assets/document/${crypto.randomUUID()}`)).status).toBe(404);
    expect((yield* get(`${document}?token=${module.token}`)).status).toBe(404);
    expect((yield* get(document, { headers: { Origin: "https://wrong.example" } })).status).toBe(
      403,
    );
    // Node fetch normalizes Host; the raw HTTP authority case is covered below.
    expect((yield* get(source, { method: "POST" })).status).toBe(405);
    revokeInlineWidget(compiled.widget.token);
    module.release();
    expect((yield* get(document)).status).toBe(404);
    expect((yield* get(source)).status).toBe(404);
    // Local IPC and remote HTTP readers share the same publication, not independent copies.
    const local = publishInlineWidget({ token: crypto.randomUUID(), document: "local document" });
    const localResponse = yield* get(`${base}/widget-assets/document/${local.token}`);
    expect(yield* Effect.promise(() => localResponse.text())).toBe("local document");
    revokeInlineWidget(local.token);
  }).pipe(Effect.scoped),
);

it.live(
  "review keeps the candidate published across remote capture and provider acceptance, then revokes it",
  () =>
    Effect.gen(function* () {
      const { backend, listener, url } = yield* start();
      const { client } = yield* connectClient(url);
      yield* client["backendConnection.connect"]({ buildId: cakeBuildId });
      const events = yield* observe(client["application.observeEvents"]());
      const requests = Context.get(backend.context, RendererRequestCoordinator);
      const sessionId = crypto.randomUUID();
      yield* requests.registerProjectSession(sessionId, "/project");
      yield* requests.bind({ _tag: "ProjectSession", sessionId }, 1);
      const capture = Context.get(
        yield* Layer.build(
          RemoteRenderedWidgetCaptureLive.pipe(
            Layer.provide(Layer.succeed(RendererRequestCoordinator, requests)),
          ),
        ),
        RenderedWidgetCapture,
      );
      const original =
        "import React from 'react'; export default function App() { return <h1>Reviewed remotely</h1> }";
      const publication = yield* Deferred.make<string>();
      const host = `http://127.0.0.1:${listener.address._tag === "TcpAddress" ? listener.address.port : 0}`;
      const capturedPixels = "A".repeat(1_100_000);
      const review = yield* generateReviewedWidget(
        {
          sessionId,
          brief: "Fixture",
          fallback: "Fixture",
          model: { provider: "fixture", id: "vision" },
        },
        {
          requireVisionModel: () =>
            capture.preflight ? capture.preflight(sessionId) : Effect.void,
          generate: () =>
            Effect.succeed({
              sessionId: "fixture-generation",
              response: `\`\`\`cake-react\n${original}\n\`\`\``,
            }),
          compile: (source) =>
            Effect.gen(function* () {
              const published = publishInlineWidget(
                yield* Effect.promise(() => compileInlineWidget("react", source, "display")),
              );
              yield* Deferred.succeed(publication, published.token);
              return {
                widget: published,
                release: Effect.sync(() => revokeInlineWidget(published.token)),
              };
            }),
          repair: () => Effect.fail(new Error("Unexpected repair")),
          capture: (widget) => capture.capture(sessionId, widget, new AbortController().signal),
          review: (_source, _diagnostic, pixels) =>
            Effect.gen(function* () {
              expect(pixels).toBe(capturedPixels);
              const token = yield* Deferred.await(publication);
              expect(
                (yield* Effect.promise(() => fetch(`${host}/widget-assets/document/${token}`)))
                  .status,
              ).toBe(200);
              return { response: "ACCEPT_CURRENT" };
            }),
        },
      ).pipe(Effect.forkScoped);
      const event = yield* Queue.take(events.events).pipe(Effect.timeout("2 seconds"));
      if (event.type !== "widget-capture-requested") throw new Error("Expected capture request");
      expect(
        (yield* Effect.promise(() => fetch(`${host}/widget-assets/document/${event.widget.token}`)))
          .status,
      ).toBe(200);
      yield* client["widgets.respond-widget-capture"]({
        requestId: event.requestId,
        sessionId,
        result: { ok: true, pngBase64: capturedPixels, diagnostics: ["settled native pixels"] },
      });
      expect((yield* Fiber.join(review)).source).toBe(original);
      expect(
        (yield* Effect.promise(() => fetch(`${host}/widget-assets/document/${event.widget.token}`)))
          .status,
      ).toBe(404);
    }).pipe(Effect.scoped),
);

it.live("oversized forged capture and screenshot traffic is closed before RPC decoding", () =>
  Effect.gen(function* () {
    const { url } = yield* start();
    const socket = yield* rawClient(url);
    socket.ws.send(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "widgets.respond-widget-capture",
        payload: {
          requestId: crypto.randomUUID(),
          sessionId: "unbound",
          result: { ok: true, pngBase64: "A".repeat(1_100_000), diagnostics: [] },
        },
        headers: [],
      }),
    );
    expect(yield* Queue.take(socket.closed).pipe(Effect.timeout("2 seconds"))).toBe(1009);
    const malformed = yield* rawClient(url);
    malformed.ws.send(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "widgets.respond-widget-capture",
        payload: {
          requestId: crypto.randomUUID(),
          sessionId: "unbound",
          result: { ok: true, pngBase64: "A".repeat(1_100_000), diagnostics: Array(101).fill("x") },
        },
        headers: [],
      }),
    );
    expect(yield* Queue.take(malformed.closed).pipe(Effect.timeout("2 seconds"))).toBe(1009);
    for (const result of [
      { status: "completed", value: { data: "A".repeat(1_100_000) } },
      { status: "mode-required", value: { data: "A".repeat(1_100_000) } },
      { status: "completed", value: { data: "A".repeat(11_000_001) } },
    ]) {
      const forged = yield* rawClient(url);
      forged.ws.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "browser.respond-browser-native",
          payload: { requestId: crypto.randomUUID(), sessionId: "unbound", result },
          headers: [],
        }),
      );
      expect(yield* Queue.take(forged.closed).pipe(Effect.timeout("2 seconds"))).toBe(1009);
    }
  }).pipe(Effect.scoped),
);

it.live(
  "browser CDP screenshot replies stay bounded to a pending desktop, reject forged/late replies and settle on cancellation",
  () =>
    Effect.gen(function* () {
      const { backend, url } = yield* start({ maxPayloadBytes: 1024 * 1024 });
      const a = yield* connectClient(url);
      const b = yield* connectClient(url);
      yield* a.client["backendConnection.connect"]({ buildId: cakeBuildId });
      const events = yield* observe(a.client["application.observeEvents"]());
      const requests = Context.get(backend.context, RendererRequestCoordinator);
      const sessionId = crypto.randomUUID();
      yield* requests.registerProjectSession(sessionId, "/project");
      yield* requests.bind({ _tag: "ProjectSession", sessionId }, 1);
      const controller = new AbortController();
      const make = () =>
        requests.requestBrowserNative(
          sessionId,
          {
            operation: "cdp",
            workspacePath: "/project",
            method: "Page.captureScreenshot",
            params: {},
          },
          controller.signal,
        );
      const pending = yield* make().pipe(Effect.forkScoped);
      const event = yield* Queue.take(events.events).pipe(
        Effect.timeout("2 seconds"),
        Effect.catch(() =>
          Effect.fail(new Error(`First browser event missing: ${String(pending.pollUnsafe())}`)),
        ),
      );
      if (event.type !== "browser-native-requested") throw new Error("Expected browser CDP event");
      const image = { data: "A".repeat(1_100_000) };
      expect(
        (yield* b.client["browser.respond-browser-native"]({
          requestId: event.requestId,
          sessionId,
          result: { status: "completed", value: image },
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(pending.pollUnsafe()).toBeUndefined();
      expect(
        (yield* a.client["browser.respond-browser-native"]({
          requestId: event.requestId,
          sessionId: crypto.randomUUID(),
          result: { status: "completed", value: null },
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* a.client["browser.respond-browser-native"]({
        requestId: event.requestId,
        sessionId,
        result: { status: "completed", value: image },
      });
      expect(yield* Fiber.join(pending)).toEqual({ status: "completed", value: image });
      expect(
        (yield* a.client["browser.respond-browser-native"]({
          requestId: event.requestId,
          sessionId,
          result: { status: "completed", value: null },
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      const cancelled = yield* make().pipe(Effect.forkScoped);
      const second = yield* Queue.take(events.events).pipe(
        Effect.timeout("2 seconds"),
        Effect.catch(() =>
          Effect.fail(new Error(`Second browser event missing: ${String(cancelled.pollUnsafe())}`)),
        ),
      );
      if (second.type !== "browser-native-requested") throw new Error("Expected second CDP event");
      controller.abort();
      expect((yield* Fiber.join(cancelled).pipe(Effect.exit))._tag).toBe("Failure");
      expect(
        (yield* a.client["browser.respond-browser-native"]({
          requestId: second.requestId,
          sessionId,
          result: { status: "completed", value: null },
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      const disconnected = yield* requests
        .requestBrowserNative(
          sessionId,
          {
            operation: "events",
            workspacePath: "/project",
            methods: [],
            limit: 10,
            clear: true,
          },
          new AbortController().signal,
        )
        .pipe(Effect.forkScoped);
      const third = yield* Queue.take(events.events).pipe(Effect.timeout("2 seconds"));
      if (third.type !== "browser-native-requested")
        throw new Error("Expected third browser event");
      yield* a.close();
      expect(yield* Fiber.join(disconnected)).toMatchObject({
        status: "failed",
        message: "The browser recipient disconnected",
      });
      expect((yield* requests.requireDesktopRecipient(sessionId).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* requests
          .requestBrowserNative(
            sessionId,
            { operation: "enter", workspacePath: "/project" },
            new AbortController().signal,
          )
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
);

it.live("desktop capture responses are targeted, cancel on disconnect, and cannot be forged", () =>
  Effect.gen(function* () {
    const { backend, url } = yield* start();
    const a = yield* connectClient(url);
    const b = yield* connectClient(url);
    yield* a.client["backendConnection.connect"]({ buildId: cakeBuildId });
    const eventsA = yield* observe(a.client["application.observeEvents"]());
    const requests = Context.get(backend.context, RendererRequestCoordinator);
    const sessionId = crypto.randomUUID();
    yield* requests.registerProjectSession(sessionId, "/project");
    yield* requests.bind({ _tag: "ProjectSession", sessionId }, 1);
    const token = crypto.randomUUID();
    const widget = { token, url: `cake-widget://document/${token}` };
    const controller = new AbortController();
    const pending = yield* requests
      .requestWidgetCapture(sessionId, widget, controller.signal)
      .pipe(Effect.forkScoped);
    const event = yield* Queue.take(eventsA.events).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() =>
        Effect.fail(new Error(`First capture missing: ${String(pending.pollUnsafe())}`)),
      ),
    );
    if (event.type !== "widget-capture-requested") throw new Error("Expected capture request");
    expect(
      (yield* b.client["widgets.respond-widget-capture"]({
        requestId: event.requestId,
        sessionId,
        result: { ok: true, pngBase64: "AAAA", diagnostics: [] },
      }).pipe(Effect.exit))._tag,
    ).toBe("Failure");
    expect(pending.pollUnsafe()).toBeUndefined();
    const pixels = "A".repeat(1_100_000);
    yield* a.client["widgets.respond-widget-capture"]({
      requestId: event.requestId,
      sessionId,
      result: { ok: true, pngBase64: pixels, diagnostics: ["settled"] },
    });
    expect(yield* Fiber.join(pending)).toEqual({ pngBase64: pixels, diagnostics: ["settled"] });
    const cancelled = yield* requests
      .requestWidgetCapture(sessionId, widget, controller.signal)
      .pipe(Effect.forkScoped);
    yield* Queue.take(eventsA.events).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() =>
        Effect.fail(new Error(`Second capture missing: ${String(cancelled.pollUnsafe())}`)),
      ),
    );
    controller.abort();
    expect((yield* Fiber.join(cancelled).pipe(Effect.exit))._tag).toBe("Failure");
    const disconnected = yield* requests
      .requestWidgetCapture(sessionId, widget, new AbortController().signal)
      .pipe(Effect.forkScoped);
    yield* Queue.take(eventsA.events).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() =>
        Effect.fail(new Error(`Third capture missing: ${String(disconnected.pollUnsafe())}`)),
      ),
    );
    yield* a.close();
    expect((yield* Fiber.join(disconnected).pipe(Effect.exit))._tag).toBe("Failure");
    yield* requests.bind({ _tag: "ProjectSession", sessionId }, 2);
    expect((yield* requests.requireDesktopRecipient(sessionId).pipe(Effect.exit))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* requests
        .requestWidgetCapture(sessionId, widget, new AbortController().signal)
        .pipe(Effect.exit))._tag,
    ).toBe("Failure");
  }).pipe(Effect.scoped),
);

it.live(
  "workspace suggestions and previews use the authorized server workspace, not a device path",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "cake-remote-workspace-"))),
      (root) =>
        Effect.gen(function* () {
          const workspace = join(root, "server-project");
          yield* Effect.promise(() => mkdir(workspace));
          yield* Effect.promise(() => writeFile(join(root, "outside.txt"), "Never exposed"));
          yield* Effect.promise(() =>
            writeFile(join(workspace, "server-note.txt"), "Only on server"),
          );
          yield* Effect.promise(() =>
            writeFile(join(workspace, "server-image.png"), Buffer.from([1, 2, 3])),
          );
          const { backend, url } = yield* start();
          yield* Context.get(backend.context, ProjectAccess).allow(workspace);
          const { client } = yield* connectClient(url);
          const suggestions = yield* client["filesystem.suggest-files"]({
            workspacePath: workspace,
            prefix: "server",
          });
          expect(JSON.stringify(suggestions.suggestions)).toContain("server-note.txt");
          expect(
            yield* client["filesystem.read-workspace-file"]({
              workspacePath: workspace,
              path: "server-note.txt",
            }),
          ).toEqual({ content: "Only on server" });
          expect(
            yield* client["filesystem.read-workspace-image"]({
              workspacePath: workspace,
              path: "server-image.png",
            }),
          ).toEqual({ mimeType: "image/png", data: "AQID" });
          const forbidden = yield* Effect.result(
            client["filesystem.read-workspace-file"]({
              workspacePath: root,
              path: "server-project/server-note.txt",
            }),
          );
          expect(forbidden._tag).toBe("Failure");
          const escape = yield* Effect.result(
            client["filesystem.read-workspace-file"]({
              workspacePath: workspace,
              path: "../outside.txt",
            }),
          );
          expect(escape._tag).toBe("Failure");
        }).pipe(Effect.scoped),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
);

it.live(
  "bounded upload chunks become server-owned Pi attachments without raising the socket cap",
  () =>
    Effect.gen(function* () {
      const delivered: { text: string; attachments: ReadonlyArray<Attachment> }[] = [];
      const { backend, url } = yield* start({}, (text, attachments) =>
        delivered.push({ text, attachments }),
      );
      const connection = yield* connectClient(url);
      const { client } = connection;
      const upload = Effect.fn("NetworkTest.upload")(function* (
        kind: "file" | "image",
        name: string,
        bytes: Buffer,
      ) {
        const { id } = yield* client["attachmentUploads.open"]({
          kind,
          name,
          size: bytes.length,
          ...(kind === "image" ? { mimeType: "image/png" } : {}),
        });
        for (let offset = 0; offset < bytes.length; offset += 192 * 1024)
          yield* client["attachmentUploads.chunk"]({
            id,
            offset,
            data: bytes.subarray(offset, offset + 192 * 1024).toString("base64"),
          });
        return (yield* client["attachmentUploads.finish"]({ id })).reference;
      });
      const file = yield* upload("file", "local-file.txt", Buffer.from("selected laptop bytes"));
      const imageBytes = Buffer.alloc(1_400_000, 7);
      const image = yield* upload("image", "large-paste.png", imageBytes);
      const sessionId = "00000000-0000-4000-8000-000000000001";
      yield* client["projectSessions.start"]({
        sessionId,
        workingDirectory: "/project",
        text: "Inspect these",
        renderUserMessageAsMarkdown: false,
        attachments: [
          { kind: "file", name: "local-file.txt", path: file },
          { kind: "image", name: "large-paste.png", mimeType: "image/png", data: image },
        ],
      });
      expect(yield* Queue.take(backend.started)).toBe("Inspect these");
      expect(delivered).toHaveLength(1);
      const attached = delivered[0]?.attachments ?? [];
      expect(attached[0]).toMatchObject({ kind: "file", name: "local-file.txt" });
      const serverFile = attached[0];
      if (serverFile?.kind === "file") {
        expect(serverFile.path.startsWith("/project")).toBe(false);
        expect(yield* Effect.promise(() => readFile(serverFile.path, "utf8"))).toBe(
          "selected laptop bytes",
        );
      }
      expect(attached[1]).toEqual({
        kind: "image",
        name: "large-paste.png",
        mimeType: "image/png",
        data: imageBytes.toString("base64"),
      });
      yield* connection.close();
      yield* Queue.take(backend.cleaned);
      if (serverFile?.kind === "file")
        expect(yield* Effect.promise(() => readFile(serverFile.path, "utf8"))).toBe(
          "selected laptop bytes",
        );
      yield* Deferred.succeed(backend.finish, undefined);
    }).pipe(Effect.scoped),
);

it.live(
  "every user-turn mutation shares upload admission instead of passing an untrusted token to Pi",
  () =>
    Effect.gen(function* () {
      const { backend, url } = yield* start();
      const { client } = yield* connectClient(url);
      const sessionId = "00000000-0000-4000-8000-000000000001";
      yield* client["projectSessions.start"]({
        sessionId,
        workingDirectory: "/project",
        text: "initialize",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      yield* Queue.take(backend.started);
      const attachments = [
        {
          kind: "image" as const,
          name: "invalid.png",
          mimeType: "image/png",
          data: "cake-upload:00000000-0000-4000-8000-000000000099",
        },
      ];
      const turn = {
        sessionId,
        text: "must reject",
        attachments,
        renderUserMessageAsMarkdown: false,
      };
      const reject = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.mapError((error) => JSON.stringify(error)),
        );
      const commands = [
        reject(client["projectSessions.start"]({ ...turn, workingDirectory: "/project" })),
        reject(client["sessionChats.prompt"](turn)),
        reject(client["sessionChats.steer"](turn)),
        reject(client["sessionChats.followUp"](turn)),
        reject(client["sessionChats.editMessage"]({ ...turn, entryId: "user-entry" })),
        reject(client["cakeChats.start"]({ ...turn, tools: [], newSession: {} })),
      ];
      for (const command of commands) {
        const response = yield* Effect.result(command);
        expect(response._tag).toBe("Failure");
        if (response._tag === "Failure")
          expect(response.failure).toContain("Unknown or mismatched attachment upload");
      }
      const rawFile = yield* Effect.result(
        client["sessionChats.followUp"]({
          ...turn,
          attachments: [{ kind: "file", name: "laptop.txt", path: "/desktop/laptop.txt" }],
        }),
      );
      expect(rawFile._tag).toBe("Failure");
      if (rawFile._tag === "Failure")
        expect(JSON.stringify(rawFile.failure)).toContain(
          "Remote file attachments require an upload",
        );
      expect(backend.stats.turns).toBe(1);
      yield* Deferred.succeed(backend.finish, undefined);
    }).pipe(Effect.scoped),
);

it.live(
  "partial and finished uploads are connection-owned and cannot be admitted after disconnect",
  () =>
    Effect.gen(function* () {
      const { backend, url } = yield* start();
      const a = yield* connectClient(url);
      const b = yield* connectClient(url);
      const partial = yield* a.client["attachmentUploads.open"]({
        kind: "file",
        name: "partial.txt",
        size: 3,
      });
      yield* a.client["attachmentUploads.chunk"]({ id: partial.id, offset: 0, data: "YQ==" });
      const finished = yield* a.client["attachmentUploads.open"]({
        kind: "file",
        name: "finished.txt",
        size: 3,
      });
      yield* a.client["attachmentUploads.chunk"]({ id: finished.id, offset: 0, data: "YWJj" });
      yield* a.client["attachmentUploads.finish"]({ id: finished.id });
      expect(
        (yield* Effect.result(b.client["attachmentUploads.finish"]({ id: finished.id })))._tag,
      ).toBe("Failure");
      yield* a.close();
      yield* Queue.take(backend.cleaned);
      const c = yield* connectClient(url);
      expect(
        (yield* Effect.result(c.client["attachmentUploads.finish"]({ id: finished.id })))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          c.client["attachmentUploads.chunk"]({ id: partial.id, offset: 1, data: "Yg==" }),
        ))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
);

it.live("two_websocket_clients_share_backend_authority_and_listener_close_preserves_it", () =>
  Effect.gen(function* () {
    const { backend, listener, url } = yield* start();
    const a = yield* connectClient(url);
    const b = yield* connectClient(url);
    yield* a.client["application.setSessionPluginSharedState"]({
      sessionId: "shared",
      key: "value",
      value: "from-a",
    });
    const state = yield* b.client["application.getState"]();
    expect(JSON.stringify(state)).toContain("from-a");
    expect(backend.stats.saves).toBe(1);
    yield* listener.close();
    expect(backend.stats.backendClosed).toBe(false);
    // Acquiring another endpoint against the SAME acquired Context is not a backend restart.
    const second = yield* openNetworkListener(
      { port: 0, allowMissingOrigin: true },
      configuration,
    ).pipe(Effect.provideContext(backend.context));
    assert.equal(second.address._tag, "TcpAddress");
    const c = yield* connectClient(`ws://127.0.0.1:${second.address.port}/rpc`);
    expect(JSON.stringify(yield* c.client["application.getState"]())).toContain("from-a");
  }).pipe(Effect.scoped),
);

it.live("listener_close_terminates_idle_websocket_without_waiting_for_peer_close_handshake", () =>
  Effect.gen(function* () {
    const { backend, listener, url } = yield* start();
    const idle = yield* rawClient(url);
    // No RPC readiness exchange, and no peer response to a WebSocket close frame.
    idle.ws.pause();
    yield* listener.close();
    expect(backend.stats.backendClosed).toBe(false);
    idle.ws.resume();
    // The peer may receive the empty close frame before destruction or only the TCP close.
    expect([1005, 1006]).toContain(yield* Queue.take(idle.closed));
    // The returned close operation is idempotent.
    yield* listener.close();
  }).pipe(Effect.scoped),
);

it.live("forged_socket_metadata_cannot_complete_another_clients_pending_question", () =>
  Effect.gen(function* () {
    const { backend, url } = yield* start();
    const a = yield* connectClient(url);
    const events = yield* observe(a.client["artifacts.observeEvents"]());
    const b = yield* rawClient(url, {
      headers: { "X-Cake-Renderer-Connection": "1", "X-Cake-Correlation-Id": "forged-upgrade" },
    });
    const requests = Context.get(backend.context, RendererRequestCoordinator);
    const pending = yield* requests
      .requestUiForConnection(1, "question-session", {
        kind: "text",
        title: "Question",
        message: "Answer",
      })
      .pipe(Effect.forkScoped);
    const question = yield* Queue.take(events.events);
    assert.equal(question.type, "ui-request");
    const payload = {
      sessionId: "question-session",
      requestId: question.requestId,
      uiRequestId: question.uiRequestId,
      cancelled: false,
      value: "forged",
    };
    b.ws.send(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "artifacts.respond-ui",
        payload,
        headers: [
          ["x-cake-renderer-connection", "1"],
          ["X-Cake-Renderer-Connection", "1"],
          ["X-CAKE-CORRELATION-ID", "1:1"],
        ],
      }),
    );
    const rejected = yield* Queue.take(b.messages);
    expect(rejected).toMatchObject({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure" } });
    expect(pending.pollUnsafe()).toBeUndefined();
    yield* a.client["artifacts.respond-ui"]({ ...payload, value: "right recipient" });
    expect(yield* Fiber.join(pending)).toBe("right recipient");
    b.ws.send(
      JSON.stringify({
        _tag: "Request",
        id: "2",
        tag: "application.getHomeDirectory",
        payload: null,
        headers: [
          ["X-CAKE-RENDERER-CONNECTION", "999"],
          ["x-cake-correlation-id", "forged"],
          ["X-Cake-Correlation-Id", "forged-again"],
        ],
      }),
    );
    expect(yield* Queue.take(b.messages)).toMatchObject({
      _tag: "Exit",
      requestId: "2",
      exit: { _tag: "Success" },
    });
    expect(yield* Queue.take(backend.metadata)).toEqual({ connectionId: 2, correlationId: "2:2" });
  }).pipe(Effect.scoped),
);

it.live("disconnect_cleans_only_its_owner_and_cancels_pending_interactions", () =>
  Effect.gen(function* () {
    const { backend, url } = yield* start();
    const a = yield* connectClient(url);
    const b = yield* connectClient(url);
    const eventsA = yield* observe(a.client["artifacts.observeEvents"]());
    const eventsB = yield* observe(b.client["artifacts.observeEvents"]());
    const workspaces = Context.get(backend.context, ClientWorkspaces);
    const access = Context.get(backend.context, ProjectAccess);
    const rewording = Context.get(backend.context, RewordingRequests);
    const requests = Context.get(backend.context, RendererRequestCoordinator);
    workspaces.associateWorkspace(1, "/first");
    workspaces.associateWorkspace(2, "/second");
    yield* access.requestTrust(1, "first", "/first");
    yield* access.requestTrust(2, "second", "/second");
    const rewordA = yield* rewording.acquire(1);
    const rewordB = yield* rewording.acquire(2);
    const pendingA = yield* requests
      .requestUiForConnection(1, "a", { kind: "text", title: "A", message: "Answer A" })
      .pipe(Effect.forkScoped);
    const pendingB = yield* requests
      .requestUiForConnection(2, "b", { kind: "text", title: "B", message: "Answer B" })
      .pipe(Effect.forkScoped);
    expect((yield* Queue.take(eventsA.events)).type).toBe("ui-request");
    const questionB = yield* Queue.take(eventsB.events);
    assert.equal(questionB.type, "ui-request");
    yield* a.close();
    expect(yield* Queue.take(backend.cleaned)).toBe(1);
    expect(yield* Fiber.join(pendingA)).toBeUndefined();
    expect(workspaces.workspaceForConnection(1)).toBeUndefined();
    expect(workspaces.workspaceForConnection(2)).toBe("/second");
    expect(rewordA.signal.aborted).toBe(true);
    expect(rewordB.signal.aborted).toBe(false);
    expect(
      Exit.isFailure(yield* access.consumeTrustRequest(1, "first", "/first").pipe(Effect.exit)),
    ).toBe(true);
    yield* access.consumeTrustRequest(2, "second", "/second");
    expect(pendingB.pollUnsafe()).toBeUndefined();
    yield* b.client["artifacts.respond-ui"]({
      sessionId: "b",
      requestId: questionB.requestId,
      uiRequestId: questionB.uiRequestId,
      cancelled: false,
      value: "still here",
    });
    expect(yield* Fiber.join(pendingB)).toBe("still here");
  }).pipe(Effect.scoped),
);

it.live("real_rpc_request_and_stream_cancellation_release_without_disconnect", () =>
  Effect.gen(function* () {
    const { backend, url } = yield* start();
    const { client } = yield* connectClient(url);
    const subscription = yield* observe(client["application.observeEvents"]());
    yield* Fiber.interrupt(subscription.fiber);
    expect(yield* Queue.take(backend.subscriptionClosed)).toBe(1);
    const delay = yield* client["foundation.delay"]({ durationMs: 60000 }).pipe(Effect.forkScoped);
    // Each completed RPC is a protocol barrier, not an elapsed-time sleep.
    let active = yield* client["foundation.activeRequests"]();
    while (active.delays !== 1) active = yield* client["foundation.activeRequests"]();
    yield* Fiber.interrupt(delay);
    active = yield* client["foundation.activeRequests"]();
    while (active.delays !== 0) active = yield* client["foundation.activeRequests"]();
    expect(active).toEqual({ delays: 0, streams: 0 });
    expect(yield* client["models.list"]()).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("accepted_turn_survives_last_socket_disconnect_and_reconnect_reads_current_snapshot", () =>
  Effect.gen(function* () {
    const { backend, listener, url } = yield* start();
    const a = yield* connectClient(url);
    const b = yield* connectClient(url);
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const target = { _tag: "ProjectSession" as const, sessionId, workingDirectory: "/project" };
    const turn = yield* a.client["projectSessions.start"]({
      sessionId,
      workingDirectory: "/project",
      text: "work",
      attachments: [],
      renderUserMessageAsMarkdown: true,
    });
    expect(turn).toMatch(/^[a-f0-9-]{36}$/);
    expect(yield* Queue.take(backend.started)).toBe("work");
    yield* b.client["projectSessions.open"]({ sessionId, workingDirectory: "/project" });
    const first = yield* a.client["conversations.observe"](target).pipe(Stream.runHead);
    const second = yield* b.client["conversations.observe"](target).pipe(Stream.runHead);
    assert.equal(first._tag, "Some");
    assert.equal(second._tag, "Some");
    expect(first.value).toMatchObject({ _tag: "Snapshot", snapshot: { streaming: true } });
    expect(second.value).toMatchObject({ _tag: "Snapshot", snapshot: { streaming: true } });
    expect(backend.stats.acquisitions).toBe(1);
    yield* a.close();
    yield* b.close();
    yield* Queue.take(backend.cleaned);
    yield* Queue.take(backend.cleaned);
    expect(backend.stats.releases).toBe(0);
    expect(backend.stats.aborted).toBe(0);
    // Stopping the listener is also not Stop or backend shutdown.
    yield* listener.close();
    yield* Deferred.succeed(backend.finish, undefined);
    yield* Queue.take(backend.settled);
    const replacement = yield* openNetworkListener(
      { port: 0, allowMissingOrigin: true },
      configuration,
    ).pipe(Effect.provideContext(backend.context));
    assert.equal(replacement.address._tag, "TcpAddress");
    const c = yield* connectClient(`ws://127.0.0.1:${replacement.address.port}/rpc`);
    const current = yield* c.client["conversations.observe"](target).pipe(Stream.runHead);
    assert.equal(current._tag, "Some");
    expect(current.value).toMatchObject({
      _tag: "Snapshot",
      snapshot: { streaming: false, parts: [{ text: "Completed while disconnected" }] },
    });
    expect(backend.stats.turns).toBe(1); // Re-observation never replays the submitted mutation.
    expect(backend.stats.aborted).toBe(0);
    expect(backend.stats.backendClosed).toBe(false);
  }).pipe(Effect.scoped),
);

it.live("explicit_stop_after_reconnect_is_distinct_from_disconnect", () =>
  Effect.gen(function* () {
    const { backend, url } = yield* start();
    const a = yield* connectClient(url);
    const sessionId = "00000000-0000-4000-8000-000000000001";
    yield* a.client["projectSessions.start"]({
      sessionId,
      workingDirectory: "/project",
      text: "stop me",
      attachments: [],
      renderUserMessageAsMarkdown: false,
    });
    yield* Queue.take(backend.started);
    yield* a.close();
    yield* Queue.take(backend.cleaned);
    expect(backend.stats.aborted).toBe(0);
    const b = yield* connectClient(url);
    expect(yield* b.client["sessionChats.listQueuedMessages"]({ sessionId })).toEqual({
      steering: [],
      followUp: [],
    });
    yield* b.client["sessionChats.abort"]({ sessionId });
    yield* Queue.take(backend.settled);
    expect(backend.stats.aborted).toBe(1);
    expect(backend.stats.turns).toBe(1);
  }).pipe(Effect.scoped),
);

it.live("bind_failure_reports_actual_address_and_preserves_existing_listener", () =>
  Effect.gen(function* () {
    const { backend, listener, url } = yield* start();
    assert.equal(listener.address._tag, "TcpAddress");
    const result = yield* openNetworkListener(
      { port: listener.address.port, allowMissingOrigin: true },
      configuration,
    ).pipe(Effect.provideContext(backend.context), Effect.result);
    assert.equal(result._tag, "Failure");
    expect(result.failure).toBeInstanceOf(NetworkListenerError);
    expect(result.failure).toMatchObject({
      _tag: "NetworkListenerError",
      message: expect.stringContaining("EADDRINUSE"),
    });
    const { client } = yield* connectClient(url);
    expect(yield* client["models.list"]()).toEqual([]);
    expect(backend.stats.backendClosed).toBe(false);
  }).pipe(Effect.scoped),
);

const refused = (url: string, options?: NodeSocket.NodeWS.ClientOptions) =>
  Effect.callback<number, Error>((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(url, options);
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resume(Effect.succeed(response.statusCode ?? 0));
    });
    socket.on("open", () => {
      socket.terminate();
      resume(Effect.fail(new Error("Unexpected accepted socket")));
    });
    socket.on("error", () => undefined);
    return Effect.sync(() => socket.terminate());
  });

// Use HTTP's raw header array so Node's client cannot normalize casing or collapse duplicates.
const refusedHeaders = (url: string, headers: ReadonlyArray<string>) =>
  Effect.callback<number, Error>((resume) => {
    const target = new URL(url);
    target.protocol = "http:";
    const request = httpRequest(
      target,
      {
        headers: [
          "Connection",
          "Upgrade",
          "Upgrade",
          "websocket",
          "Sec-WebSocket-Key",
          "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version",
          "13",
          ...headers,
        ],
      },
      (response) => {
        response.resume();
        resume(Effect.succeed(response.statusCode ?? 0));
      },
    );
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resume(Effect.fail(new Error("Unexpected accepted socket")));
    });
    request.once("error", (error) => resume(Effect.fail(error)));
    request.end();
    return Effect.sync(() => request.destroy());
  });

it.live("explicit_configured_remote_authority_and_origin_can_upgrade", () =>
  Effect.gen(function* () {
    const { url } = yield* start({
      allowMissingOrigin: false,
      allowedHosts: ["cake.example"],
      allowedOrigins: ["https://cake.example"],
    });
    expect(yield* refused(url, { origin: "https://cake.example" })).toBe(403);
    const accepted = yield* rawClient(url, {
      headers: { Host: "cake.example" },
      origin: "https://cake.example",
    });
    accepted.ws.send(JSON.stringify({ _tag: "Ping" }));
    expect(yield* Queue.take(accepted.messages)).toEqual({ _tag: "Pong" });
  }).pipe(Effect.scoped),
);

it.live("upgrade_rejects_unexpected_host_origin_path_and_bounds_payload", () =>
  Effect.gen(function* () {
    const { url } = yield* start({
      allowMissingOrigin: false,
      allowedOrigins: ["https://trusted.example"],
      maxPayloadBytes: 1024,
    });
    expect(yield* refused(url)).toBe(403);
    expect(yield* refused(url, { origin: "https://attacker.example" })).toBe(403);
    expect(
      yield* refused(url, {
        origin: "https://trusted.example",
        headers: { Host: "attacker.example" },
      }),
    ).toBe(403);
    expect(
      yield* refusedHeaders(url, [
        "Host",
        new URL(url).host,
        "Host",
        "attacker.example",
        "Origin",
        "https://trusted.example",
      ]),
    ).toBe(403);
    expect(
      yield* refusedHeaders(url, [
        "Host",
        new URL(url).host,
        "hOsT",
        "attacker.example",
        "Origin",
        "https://trusted.example",
      ]),
    ).toBe(403);
    expect(
      yield* refusedHeaders(url, [
        "Host",
        new URL(url).host,
        "Origin",
        "https://trusted.example",
        "oRiGiN",
        "https://trusted.example",
      ]),
    ).toBe(403);
    expect(yield* refused(`${url}?query=1`, { origin: "https://trusted.example" })).toBe(404);
    expect(
      yield* refused(url.replace("/rpc", "/other"), { origin: "https://trusted.example" }),
    ).toBe(404);
    const accepted = yield* rawClient(url, { origin: "https://trusted.example" });
    accepted.ws.send("x".repeat(1025));
    expect(yield* Queue.take(accepted.closed)).toBe(1009);
  }).pipe(Effect.scoped),
);
