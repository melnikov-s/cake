import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { ClientConnectionsLive } from "../../../../src/services/clients/ClientConnections";
import { AttachmentUploads } from "../../../../src/services/filesystem/AttachmentUploads";
import { makeAttachmentUploadsLive } from "../../../../src/services/filesystem/AttachmentUploadsLive";

const attachmentLayer = (root: string) =>
  makeAttachmentUploadsLive(root, root).pipe(Layer.provide(ClientConnectionsLive));

const fixture = <A, E>(
  operation: (uploads: typeof AttachmentUploads.Service, root: string) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-upload-test-"))),
    (root) =>
      Effect.flatMap(AttachmentUploads, (uploads) => operation(uploads, root)).pipe(
        Effect.provide(attachmentLayer(root)),
      ),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

const file = (name: string, path: string) => ({ kind: "file" as const, name, path });

describe("AttachmentUploadsLive", () => {
  it.effect("expires an abandoned upload after ten minutes without keeping its disk payload", () =>
    fixture((uploads, root) =>
      Effect.gen(function* () {
        const { id } = yield* uploads.open(3, { kind: "file", name: "abandoned.txt", size: 3 });
        yield* uploads.chunk(3, { id, offset: 0, data: "YWJj" });
        yield* TestClock.adjust("11 minutes");
        expect((yield* Effect.result(uploads.finish(3, id)))._tag).toBe("Failure");
        expect(
          (yield* Effect.result(
            Effect.tryPromise(() => stat(join(root, "attachments", "staging", id))),
          ))._tag,
        ).toBe("Failure");
      }),
    ),
  );
  it.effect("keeps accepted files after backend restart but removes crash-orphaned staging", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "cake-upload-restart-"))),
      (root) =>
        Effect.gen(function* () {
          const accepted = yield* Effect.scoped(
            Effect.gen(function* () {
              const uploads = yield* AttachmentUploads;
              const { id } = yield* uploads.open(1, {
                kind: "file",
                name: "persistent.txt",
                size: 3,
              });
              yield* uploads.chunk(1, { id, offset: 0, data: "YWJj" });
              const { reference } = yield* uploads.finish(1, id);
              const [attachment] = yield* uploads.admit(1, [file("persistent.txt", reference)]);
              if (attachment?.kind !== "file") throw new Error("Expected accepted file");
              return attachment.path;
            }).pipe(Effect.provide(attachmentLayer(root))),
          );
          const orphan = join(root, "attachments", "staging", "orphan");
          yield* Effect.promise(() => writeFile(orphan, "crashed before acceptance"));
          yield* Effect.scoped(
            Effect.flatMap(AttachmentUploads, () => Effect.void).pipe(
              Effect.provide(attachmentLayer(root)),
            ),
          );
          expect((yield* Effect.result(Effect.tryPromise(() => stat(orphan))))._tag).toBe(
            "Failure",
          );
          expect(yield* Effect.promise(() => readFile(accepted, "utf8"))).toBe("abc");
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  );
  it.effect(
    "bounds chunks, declared size, owner capacity, malformed references and cross-client admission",
    () =>
      fixture((uploads) =>
        Effect.gen(function* () {
          const oversized = yield* Effect.result(
            uploads.open(1, { kind: "file", name: "big", size: 8 * 1024 * 1024 + 1 }),
          );
          expect(oversized._tag).toBe("Failure");
          expect(
            (yield* Effect.result(uploads.admit(1, [file("laptop.txt", "/laptop/laptop.txt")])))
              ._tag,
          ).toBe("Failure");
          for (const name of ["../escaped.txt", "folder/file.txt", ".", ".."])
            expect(
              (yield* Effect.result(uploads.open(1, { kind: "file", name, size: 3 })))._tag,
            ).toBe("Failure");
          const { id } = yield* uploads.open(1, { kind: "file", name: "note.txt", size: 3 });
          expect(
            (yield* Effect.result(uploads.chunk(2, { id, offset: 0, data: "YWJj" })))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.result(uploads.chunk(1, { id, offset: 0, data: "@@@" })))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.result(uploads.chunk(1, { id, offset: 0, data: "YWJjZA==" })))._tag,
          ).toBe("Failure");
          expect((yield* Effect.result(uploads.finish(1, id)))._tag).toBe("Failure");
          yield* uploads.chunk(1, { id, offset: 0, data: "YWJj" });
          expect(
            (yield* Effect.result(uploads.chunk(1, { id, offset: 0, data: "YWJj" })))._tag,
          ).toBe("Failure");
          const { reference } = yield* uploads.finish(1, id);
          expect((yield* Effect.result(uploads.admit(2, [file("note.txt", reference)])))._tag).toBe(
            "Failure",
          );
          expect(
            (yield* Effect.result(uploads.admit(1, [file("wrong-name", reference)])))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.result(uploads.admit(1, [file("note.txt", "cake-upload:invalid")])))
              ._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.result(
              uploads.admit(1, [file("note.txt", reference), file("note.txt", reference)]),
            ))._tag,
          ).toBe("Failure");
          const admitted = yield* uploads.admit(1, [file("note.txt", reference)]);
          const accepted = admitted[0];
          expect(accepted?.kind).toBe("file");
          if (accepted?.kind === "file")
            expect(yield* Effect.promise(() => readFile(accepted.path, "utf8"))).toBe("abc");
          expect((yield* Effect.result(uploads.admit(1, [file("note.txt", reference)])))._tag).toBe(
            "Failure",
          );
        }),
      ),
  );

  it.effect(
    "discards incomplete/finished uploads on cancellation or disconnect; accepted files survive cleanup and layer restart",
    () =>
      fixture((uploads, root) =>
        Effect.gen(function* () {
          const partial = yield* uploads.open(4, {
            kind: "image",
            name: "paste.png",
            mimeType: "image/png",
            size: 4,
          });
          yield* uploads.chunk(4, { id: partial.id, offset: 0, data: "AQI=" });
          yield* uploads.discard(4, partial.id);
          expect((yield* Effect.result(uploads.finish(4, partial.id)))._tag).toBe("Failure");
          const abandoned = yield* uploads.open(4, {
            kind: "file",
            name: "abandoned.txt",
            size: 3,
          });
          yield* uploads.chunk(4, { id: abandoned.id, offset: 0, data: "YWJj" });
          yield* uploads.finish(4, abandoned.id);
          const retained = yield* uploads.open(5, { kind: "file", name: "kept.txt", size: 3 });
          yield* uploads.chunk(5, { id: retained.id, offset: 0, data: "YWJj" });
          const { reference } = yield* uploads.finish(5, retained.id);
          const accepted = (yield* uploads.admit(5, [file("kept.txt", reference)]))[0];
          yield* uploads.releaseConnection(4);
          yield* uploads.releaseConnection(5);
          expect(
            (yield* Effect.result(
              uploads.admit(4, [file("abandoned.txt", `cake-upload:${abandoned.id}`)]),
            ))._tag,
          ).toBe("Failure");
          if (accepted?.kind === "file") {
            expect(yield* Effect.promise(() => readFile(accepted.path, "utf8"))).toBe("abc");
            expect((yield* Effect.promise(() => stat(accepted.path))).isFile()).toBe(true);
            expect(accepted.path.startsWith(join(root, "attachments", "accepted"))).toBe(true);
          }
        }),
      ),
  );
});
