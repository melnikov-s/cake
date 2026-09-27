import { mkdir, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Clock, Effect, Layer, Schedule, Semaphore } from "effect";
import type { Attachment } from "../../ipc/session-contract";
import { ClientConnections } from "../clients/ClientConnections";
import {
  AttachmentUploadError,
  AttachmentUploads,
  uploadId,
  uploadReference,
} from "./AttachmentUploads";

const MAX_FILE = 8 * 1024 * 1024;
const MAX_IMAGE = 15_000_000;
const MAX_CHUNK = 192 * 1024;
const MAX_OWNER = 32 * 1024 * 1024;
const MAX_GLOBAL = 64 * 1024 * 1024;
const EXPIRES_MS = 10 * 60 * 1000;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
interface Upload {
  readonly owner: number;
  readonly kind: "file" | "image";
  readonly name: string;
  readonly mimeType?: string;
  readonly size: number;
  readonly path: string;
  readonly created: number;
  offset: number;
  finished: boolean;
}
const failure = (operation: string, message: string) =>
  new AttachmentUploadError({ operation, message });

/** Disk-backed, connection-owned staging; accepted file paths survive restarts and later Pi turns. */
export const makeAttachmentUploadsLive = (cache: string, state: string) =>
  Layer.effect(
    AttachmentUploads,
    Effect.gen(function* () {
      const connections = yield* ClientConnections;
      const staging = join(cache, "attachments", "staging");
      const accepted = join(state, "attachments", "accepted");
      // No upload identity survives backend restart. Remove crash-orphaned staging,
      // never the accepted files referenced by Pi's durable transcript.
      yield* Effect.promise(async () => {
        await rm(staging, { recursive: true, force: true });
        await Promise.all([
          mkdir(staging, { recursive: true }),
          mkdir(accepted, { recursive: true }),
        ]);
      });
      const entries = new Map<string, Upload>();
      const lock = yield* Semaphore.make(1);
      const guarded = <A, E>(effect: Effect.Effect<A, E>) =>
        lock.withPermits(1)(Effect.uninterruptible(effect));
      const remove = (id: string, entry: Upload) => {
        entries.delete(id);
        return Effect.promise(() => rm(entry.path, { force: true }));
      };
      const expired = Effect.fn("AttachmentUploads.expired")(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [id, entry] of entries)
          if (now - entry.created > EXPIRES_MS) yield* remove(id, entry);
      });
      yield* Effect.repeat(guarded(expired()), Schedule.spaced("60 seconds")).pipe(
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const [id, entry] of entries) yield* remove(id, entry);
        }),
      );
      const open = Effect.fn("AttachmentUploads.open")(
        (
          owner: number,
          input: { kind: "file" | "image"; name: string; mimeType?: string; size: number },
        ) =>
          guarded(
            Effect.gen(function* () {
              yield* expired();
              if (
                !Number.isSafeInteger(input.size) ||
                input.size < 1 ||
                input.size > (input.kind === "image" ? MAX_IMAGE : MAX_FILE)
              )
                return yield* failure("open", "Attachment exceeds the upload size limit");
              if (
                input.name.length < 1 ||
                input.name.length > 512 ||
                input.name === "." ||
                input.name === ".." ||
                /[\\/\0]/.test(input.name)
              )
                return yield* failure("open", "Invalid attachment name");
              if (
                input.kind === "image" &&
                !["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(
                  input.mimeType ?? "",
                )
              )
                return yield* failure("open", "Unsupported image type");
              const values = [...entries.values()];
              if (
                values.filter((entry) => entry.owner === owner).length >= 20 ||
                values
                  .filter((entry) => entry.owner === owner)
                  .reduce((sum, entry) => sum + entry.size, 0) +
                  input.size >
                  MAX_OWNER ||
                values.reduce((sum, entry) => sum + entry.size, 0) + input.size > MAX_GLOBAL
              )
                return yield* failure("open", "Too many pending attachment bytes");
              const id = randomUUID();
              const path = join(staging, id);
              yield* Effect.tryPromise({
                try: () => writeFile(path, "", { flag: "wx" }),
                catch: (cause) => failure("open", String(cause)),
              });
              entries.set(id, {
                owner,
                kind: input.kind,
                name: input.name,
                mimeType: input.mimeType,
                size: input.size,
                path,
                created: yield* Clock.currentTimeMillis,
                offset: 0,
                finished: false,
              });
              return { id };
            }),
          ),
      );
      const chunk = Effect.fn("AttachmentUploads.chunk")(
        (owner: number, input: { id: string; offset: number; data: string }) =>
          guarded(
            Effect.gen(function* () {
              const entry = entries.get(input.id);
              if (!entry || entry.owner !== owner || entry.finished)
                return yield* failure("chunk", "Unknown upload");
              if (
                entry.offset !== input.offset ||
                !base64.test(input.data) ||
                input.data.length > 4 * Math.ceil(MAX_CHUNK / 3)
              )
                return yield* failure("chunk", "Invalid upload chunk");
              const bytes = Buffer.from(input.data, "base64");
              if (
                !bytes.length ||
                bytes.length > MAX_CHUNK ||
                entry.offset + bytes.length > entry.size
              )
                return yield* failure("chunk", "Upload chunk exceeds declared size");
              yield* Effect.tryPromise({
                try: () => appendFile(entry.path, bytes),
                catch: (cause) => failure("chunk", String(cause)),
              });
              entry.offset += bytes.length;
            }),
          ),
      );
      const finish = Effect.fn("AttachmentUploads.finish")((owner: number, id: string) =>
        guarded(
          Effect.gen(function* () {
            const entry = entries.get(id);
            if (!entry || entry.owner !== owner || entry.offset !== entry.size)
              return yield* failure("finish", "Incomplete or unknown upload");
            entry.finished = true;
            return { reference: uploadReference(id) };
          }),
        ),
      );
      const discard = Effect.fn("AttachmentUploads.discard")((owner: number, id: string) =>
        guarded(
          Effect.gen(function* () {
            const entry = entries.get(id);
            if (entry?.owner === owner) yield* remove(id, entry);
          }),
        ),
      );
      const releaseConnection = Effect.fn("AttachmentUploads.releaseConnection")((owner: number) =>
        guarded(
          Effect.gen(function* () {
            for (const [id, entry] of entries) if (entry.owner === owner) yield* remove(id, entry);
          }),
        ),
      );
      const admit = Effect.fn("AttachmentUploads.admit")(
        (owner: number, attachments: ReadonlyArray<Attachment>) =>
          guarded(
            Effect.gen(function* () {
              yield* expired();
              const pending = attachments.map((item) => {
                const id =
                  item.kind === "file"
                    ? uploadId(item.path)
                    : item.kind === "image"
                      ? uploadId(item.data)
                      : undefined;
                return { item, id, entry: id ? entries.get(id) : undefined };
              });
              const used = new Set<string>();
              for (const { item, id, entry } of pending) {
                const value =
                  item.kind === "file" ? item.path : item.kind === "image" ? item.data : "";
                if (value.startsWith("cake-upload:") && !id)
                  return yield* failure("admit", "Invalid attachment reference");
                if (!id) {
                  if (item.kind === "file" && connections.nativeId(owner) === undefined)
                    return yield* failure("admit", "Remote file attachments require an upload");
                  continue;
                }
                if (used.has(id)) return yield* failure("admit", "Duplicate attachment upload");
                used.add(id);
                if (
                  !entry ||
                  entry.owner !== owner ||
                  !entry.finished ||
                  entry.kind !== item.kind ||
                  entry.name !== item.name ||
                  (item.kind === "image" && entry.mimeType !== item.mimeType)
                )
                  return yield* failure("admit", "Unknown or mismatched attachment upload");
              }
              const result: Attachment[] = [];
              for (const { item, id, entry } of pending) {
                if (!id || !entry) {
                  result.push(item);
                  continue;
                }
                if (entry.kind === "file") {
                  const path = join(accepted, id, entry.name);
                  yield* Effect.tryPromise({
                    try: async () => {
                      await mkdir(join(accepted, id));
                      await rename(entry.path, path);
                    },
                    catch: (cause) => failure("admit", String(cause)),
                  });
                  entries.delete(id);
                  result.push({ kind: "file", name: entry.name, path });
                } else {
                  const data = yield* Effect.tryPromise({
                    try: () => readFile(entry.path),
                    catch: (cause) => failure("admit", String(cause)),
                  });
                  yield* remove(id, entry);
                  result.push({
                    kind: "image",
                    name: entry.name,
                    mimeType: entry.mimeType ?? "image/png",
                    data: data.toString("base64"),
                  });
                }
              }
              return result;
            }),
          ),
      );
      return AttachmentUploads.of({ open, chunk, finish, discard, admit, releaseConnection });
    }),
  );
