import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { releaseConnectionResources } from "../../../../src/domain/clients/clientConnectionResources";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../../src/services/clients/ClientConnections";
import { AttachmentUploads } from "../../../../src/services/filesystem/AttachmentUploads";
import { makeAttachmentUploadsLive } from "../../../../src/services/filesystem/AttachmentUploadsLive";
import { InlineWidgets } from "../../../../src/services/widgets/InlineWidgets";
import { makeInlineWidgetsLive } from "../../../../src/services/widgets/InlineWidgetsLive";
import { WidgetBrowserOutputs } from "../../../../src/services/widgets/WidgetBrowserOutputs";
import { makeWidgetBrowserOutputsLive } from "../../../../src/services/widgets/WidgetBrowserOutputsLive";
import { WidgetPackages } from "../../../../src/services/widgets/WidgetPackages";
import {
  inlineWidgetResource,
  publishInlineWidget,
  revokeInlineWidget,
} from "../../../../src/services/widgets/inline-widget-document-registry";
import type { CompiledInlineWidgetDocument } from "../../../../src/services/widgets/inline-widget-service";

const fixture = <A, E>(
  run: (
    tokens: Set<string>,
  ) => Effect.Effect<
    A,
    E,
    InlineWidgets | WidgetBrowserOutputs | ClientConnections | AttachmentUploads
  >,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-widget-lifetimes-"))),
    (root) => {
      const tokens = new Set<string>();
      const dependencies = Layer.mergeAll(
        ClientConnectionsLive,
        Layer.mock(WidgetPackages, { directory: root }),
        makeWidgetBrowserOutputsLive(join(root, "browser")),
      );
      const widgets = makeInlineWidgetsLive({
        publish: (compiled) => {
          tokens.add(compiled.token);
          return publishInlineWidget(compiled);
        },
        revoke: (token) => {
          tokens.delete(token);
          revokeInlineWidget(token);
        },
      }).pipe(Layer.provide(dependencies));
      return run(tokens).pipe(
        Effect.provide(
          Layer.mergeAll(
            dependencies,
            widgets,
            makeAttachmentUploadsLive(root, root).pipe(Layer.provide(dependencies)),
          ),
        ),
      );
    },
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );
const compiled = (): CompiledInlineWidgetDocument => ({
  token: "fixture-token",
  document: "<h1>fixture-token</h1>",
  assets: [{ path: "assets/0/image.png", contentType: "image/png", data: Buffer.alloc(1024) }],
});

describe("InlineWidgets publication ownership", () => {
  it.effect("layer shutdown revokes all remaining publications", () =>
    Effect.gen(function* () {
      const { token, tokens } = yield* fixture((tokens) =>
        Effect.gen(function* () {
          const clients = yield* ClientConnections;
          const widgets = yield* InlineWidgets;
          const widget = (yield* widgets.compile(clients.socket(), {
            language: "html",
            source: "<h1>Until shutdown</h1>",
            capability: "display",
          })).widget;
          expect(tokens.size).toBe(1);
          return { token: widget.token, tokens };
        }),
      );
      expect(tokens.size).toBe(0);
      expect(inlineWidgetResource(token, "")).toBeUndefined();
    }),
  );

  it.effect(
    "repeated widget open/close bounds retained tokens/assets, while multiple mounts survive one release",
    () =>
      fixture((tokens) =>
        Effect.gen(function* () {
          const widgets = yield* InlineWidgets;
          const outputs = yield* WidgetBrowserOutputs;
          const clients = yield* ClientConnections;
          const owner = clients.socket();
          const otherOwner = clients.socket();
          const browser = yield* outputs.retain(compiled());
          const first = (yield* widgets.open(owner, { browser })).widget;
          const second = (yield* widgets.open(owner, { browser })).widget;
          const other = (yield* widgets.open(otherOwner, { browser })).widget;
          expect(tokens.size).toBe(3);
          expect(first.token).not.toBe(second.token);
          const firstAsset = inlineWidgetResource(first.token, "assets/0/image.png")?.data;
          expect(inlineWidgetResource(second.token, "assets/0/image.png")?.data).toBe(firstAsset);
          expect(inlineWidgetResource(other.token, "assets/0/image.png")?.data).toBe(firstAsset);
          yield* widgets.release(otherOwner, first.token);
          expect(inlineWidgetResource(first.token, "")).toBeDefined();
          yield* widgets.release(owner, first.token);
          yield* widgets.release(owner, first.token);
          expect(inlineWidgetResource(first.token, "")).toBeUndefined();
          expect(inlineWidgetResource(second.token, "")).toBeDefined();
          yield* widgets.release(owner, second.token);
          yield* widgets.release(otherOwner, other.token);
          expect(tokens.size).toBe(0);
          // No idle cache survives the last mount: the next generation reads fresh buffers.
          for (let index = 0; index < 20; index++) {
            const next = (yield* widgets.open(owner, { browser })).widget;
            expect(tokens.size).toBe(1);
            expect(inlineWidgetResource(next.token, "assets/0/image.png")?.data).not.toBe(
              firstAsset,
            );
            yield* widgets.release(owner, next.token);
            expect(tokens.size).toBe(0);
            expect(inlineWidgetResource(next.token, "assets/0/image.png")).toBeUndefined();
          }
        }),
      ),
  );

  it.effect(
    "disconnect releases owned tokens/uploads idempotently and leaves other owners live",
    () =>
      fixture((tokens) =>
        Effect.gen(function* () {
          const widgets = yield* InlineWidgets;
          const uploads = yield* AttachmentUploads;
          const clients = yield* ClientConnections;
          const owner = clients.socket();
          const other = clients.socket();
          const publication = (yield* widgets.compile(owner, {
            language: "html",
            source: "<h1>owned</h1>",
            capability: "display",
          })).widget;
          const survivor = (yield* widgets.compile(other, {
            language: "html",
            source: "<h1>other</h1>",
            capability: "display",
          })).widget;
          const upload = yield* uploads.open(owner, { kind: "file", name: "partial.txt", size: 3 });
          const otherUpload = yield* uploads.open(other, {
            kind: "file",
            name: "other.txt",
            size: 3,
          });
          clients.release(owner);
          yield* releaseConnectionResources(owner);
          yield* releaseConnectionResources(owner);
          expect(tokens.size).toBe(1);
          expect(inlineWidgetResource(publication.token, "")).toBeUndefined();
          expect(inlineWidgetResource(survivor.token, "")).toBeDefined();
          expect(
            (yield* uploads
              .chunk(owner, { id: upload.id, offset: 0, data: "YWJj" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* uploads.chunk(other, { id: otherUpload.id, offset: 0, data: "YWJj" });
          yield* uploads.finish(other, otherUpload.id);
          yield* releaseConnectionResources(other);
          expect(tokens.size).toBe(0);
        }),
      ),
  );

  it.effect("disconnect during acquisition cannot publish a late capability", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<CompiledInlineWidgetDocument>();
      const tokens = new Set<string>();
      const connections = yield* ClientConnections;
      const owner = connections.socket();
      const layer = makeInlineWidgetsLive({
        publish: (value) => {
          tokens.add(value.token);
          return publishInlineWidget(value);
        },
        revoke: revokeInlineWidget,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ClientConnections, connections),
            Layer.mock(WidgetPackages, { directory: "/unused" }),
            Layer.mock(WidgetBrowserOutputs, {
              open: () =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(complete))),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const widgets = yield* InlineWidgets;
        const pending = yield* widgets
          .open(owner, { browser: { digest: "a".repeat(64) } })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        connections.release(owner);
        yield* releaseConnectionResources(owner);
        yield* Deferred.succeed(complete, compiled());
        expect((yield* Fiber.join(pending).pipe(Effect.result))._tag).toBe("Failure");
        expect(tokens.size).toBe(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(ClientConnectionsLive)),
  );
});
