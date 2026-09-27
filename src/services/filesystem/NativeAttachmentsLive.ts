import { open, readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { BrowserWindow, dialog } from "electron";
import { Effect, Layer } from "effect";
import type { Attachment } from "../../ipc/session-contract";
import { Electron } from "../electron/Electron";
import { NativeAttachments } from "./NativeAttachments";
import { WorkspaceFileError } from "./WorkspaceFiles";

const imageMimeTypes = new Map([
  [".avif", "image/avif"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export const NativeAttachmentsLive = Layer.effect(
  NativeAttachments,
  Effect.gen(function* () {
    const electron = yield* Electron;
    const selected = new Map<
      number,
      Map<string, { size: number; mtimeMs: number; expires: number }>
    >();
    const readSelected = Effect.fn("NativeAttachments.readSelected")(function* (
      connectionId: number,
      request: { path: string; offset: number },
    ) {
      yield* Effect.try({
        try: () => electron.requireRendererConnection(connectionId),
        catch: () =>
          new WorkspaceFileError({
            operation: "readSelected",
            message: "Device connection closed",
          }),
      });
      const grant = selected.get(connectionId)?.get(request.path);
      if (
        !grant ||
        grant.expires < Date.now() ||
        !Number.isSafeInteger(request.offset) ||
        request.offset < 0 ||
        request.offset >= grant.size
      )
        return yield* new WorkspaceFileError({
          operation: "readSelected",
          message: "File was not selected on this device",
        });
      return yield* Effect.tryPromise({
        try: async () => {
          const handle = await open(request.path, "r");
          try {
            const metadata = await handle.stat();
            if (
              !metadata.isFile() ||
              metadata.size !== grant.size ||
              metadata.mtimeMs !== grant.mtimeMs
            )
              throw new Error("Selected file changed before transfer");
            const bytes = Buffer.alloc(Math.min(192 * 1024, grant.size - request.offset));
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, request.offset);
            if (!bytesRead) throw new Error("Selected file could not be read");
            return { data: bytes.subarray(0, bytesRead).toString("base64"), size: grant.size };
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          new WorkspaceFileError({ operation: "readSelected", message: String(cause) }),
      });
    });
    const choose = Effect.fn("NativeAttachments.choose")(function* (connectionId: number) {
      const sender = yield* Effect.try({
        try: () => electron.requireRendererConnection(connectionId),
        catch: (cause) =>
          new WorkspaceFileError({ operation: "chooseAttachments", message: String(cause) }),
      });
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) return { attachments: [] };
      const result = yield* Effect.tryPromise({
        try: () => dialog.showOpenDialog(owner, { properties: ["openFile", "multiSelections"] }),
        catch: (cause) =>
          new WorkspaceFileError({ operation: "chooseAttachments", message: String(cause) }),
      });
      if (result.canceled) return { attachments: [] };
      const grants =
        selected.get(connectionId) ??
        new Map<string, { size: number; mtimeMs: number; expires: number }>();
      for (const [path, grant] of grants) if (grant.expires < Date.now()) grants.delete(path);
      const attachments = yield* Effect.tryPromise({
        try: () =>
          Promise.all(
            result.filePaths.slice(0, 20).map(async (path): Promise<Attachment> => {
              const mimeType = imageMimeTypes.get(extname(path).toLowerCase());
              if (!mimeType) {
                const metadata = await stat(path);
                if (!metadata.isFile() || metadata.size < 1 || metadata.size > 8 * 1024 * 1024)
                  throw new Error("Selected file is too large or empty");
                grants.set(path, {
                  size: metadata.size,
                  mtimeMs: metadata.mtimeMs,
                  expires: Date.now() + 10 * 60_000,
                });
                return { kind: "file", name: basename(path), path };
              }
              const metadata = await stat(path);
              if (!metadata.isFile() || metadata.size > 15_000_000)
                throw new Error("Selected image is too large");
              const data = await readFile(path);
              if (data.byteLength > 15_000_000) throw new Error("Selected image is too large");
              return {
                kind: "image",
                name: basename(path),
                mimeType,
                data: data.toString("base64"),
              };
            }),
          ),
        catch: (cause) =>
          new WorkspaceFileError({ operation: "chooseAttachments", message: String(cause) }),
      });
      selected.set(connectionId, grants);
      return { attachments };
    });
    return NativeAttachments.of({ choose, readSelected });
  }),
);
