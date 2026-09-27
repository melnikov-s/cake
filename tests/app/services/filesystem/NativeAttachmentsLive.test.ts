import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { Electron } from "../../../../src/services/electron/Electron";
import { NativeAttachments } from "../../../../src/services/filesystem/NativeAttachments";
import { NativeAttachmentsLive } from "../../../../src/services/filesystem/NativeAttachmentsLive";

const native = vi.hoisted(() => ({ selected: [] as string[] }));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: native.selected }) },
}));

const layer = NativeAttachmentsLive.pipe(
  Layer.provide(
    Layer.mock(Electron, {
      requireRendererConnection: () => Object.assign(Object.create(null), { id: 1 }),
      windowsForWorkspace: () => [],
      centerTrafficLights: () => {},
    }),
  ),
);

describe("NativeAttachmentsLive", () => {
  it.effect("reads bounded bytes only after that device owner selected the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "cake-native-attachment-"))),
      (root) =>
        Effect.gen(function* () {
          const selected = join(root, "selected.txt");
          const secret = join(root, "not-selected.txt");
          yield* Effect.promise(() => writeFile(selected, "desktop only"));
          yield* Effect.promise(() => writeFile(secret, "not granted"));
          const files = yield* NativeAttachments;
          expect(
            (yield* Effect.result(files.readSelected(1, { path: selected, offset: 0 })))._tag,
          ).toBe("Failure");
          native.selected = [selected];
          expect((yield* files.choose(1)).attachments).toEqual([
            { kind: "file", name: "selected.txt", path: selected },
          ]);
          expect(yield* files.readSelected(1, { path: selected, offset: 0 })).toEqual({
            data: Buffer.from("desktop only").toString("base64"),
            size: 12,
          });
          expect(
            (yield* Effect.result(files.readSelected(2, { path: selected, offset: 0 })))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.result(files.readSelected(1, { path: secret, offset: 0 })))._tag,
          ).toBe("Failure");
          yield* Effect.promise(() => writeFile(selected, "different bytes"));
          expect(
            (yield* Effect.result(files.readSelected(1, { path: selected, offset: 0 })))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(layer)),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  );
});
