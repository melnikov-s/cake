import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Clock, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { attachmentSchema, type Attachment } from "../../ipc/session-contract";
import {
  TaskInputReference,
  MAX_PASTED_TEXT_BYTES,
} from "../../contracts/conversations/task-input";
import { AttachmentUploadError } from "../../contracts/filesystem/attachment-uploads-errors";
import { TaskInputStorage } from "./TaskInputStorage";

const StoredInput = Schema.Struct({
  ownerSessionId: Schema.String,
  reference: TaskInputReference,
});
const Grant = Schema.Struct({
  ownerSessionId: Schema.String,
  ids: Schema.Array(Schema.String.check(Schema.isUUID(4))),
  recipientSessionId: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
});
const ForwardReference = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/));
const imageExtension = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
]);
const failure = (operation: string) =>
  new AttachmentUploadError({
    operation,
    message: "Task input is unavailable, unauthorized, or exceeds its size limit",
  });

/** Originals are pinned for replay, outside projects/worktrees and the Artifact library.
 * Atomic per-input documents are not a copy of a transcript. No age-based deletion of
 * accepted inputs: future collection must follow all referencing histories, not resolution.
 */
export const makeTaskInputStorageLive = (state: string) =>
  Layer.effect(
    TaskInputStorage,
    Effect.gen(function* () {
      const root = join(state, "task-inputs");
      const inputs = join(root, "inputs");
      const grants = join(root, "grants");
      const recipients = join(root, "recipients");
      yield* Effect.promise(() =>
        Promise.all(
          [inputs, grants, recipients].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
        ),
      );
      const lock = yield* Semaphore.make(1);
      const io = <A>(operation: string, work: () => Promise<A>) =>
        Effect.tryPromise({ try: work, catch: () => failure(operation) });
      const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
        path: string,
        schema: S,
      ) =>
        io("read", () => readFile(path, "utf8")).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value),
          ),
          Effect.mapError(() => failure("read")),
        );
      const atomic = (
        path: string,
        value: typeof StoredInput.Type | typeof Grant.Type | Attachment | boolean,
      ) =>
        io("write", async () => {
          const temp = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
            await rename(temp, path);
          } finally {
            await rm(temp, { force: true });
          }
        });
      const id = (value: string) =>
        Schema.decodeUnknownEffect(TaskInputReference.fields.id)(value).pipe(
          Effect.mapError(() => failure("id")),
        );
      const stored = Effect.fn("TaskInputStorage.stored")(function* (value: string) {
        const key = yield* id(value);
        return yield* read(join(inputs, `${key}.json`), StoredInput);
      });
      const payload = Effect.fn("TaskInputStorage.payload")(function* (value: string) {
        const key = yield* id(value);
        return yield* read(join(inputs, key, "payload.json"), attachmentSchema);
      });
      const isolate = Effect.fn("TaskInputStorage.isolate")(function* (
        ownerSessionId: string,
        attachments: readonly Attachment[],
      ) {
        const result: TaskInputReference[] = [];
        for (const attachment of attachments) {
          if (attachment.kind === "forwarded-input") return yield* failure("isolate");
          if (attachment.kind === "input") {
            const existing = yield* stored(attachment.id);
            if (existing.ownerSessionId !== ownerSessionId) return yield* failure("isolate");
            result.push(existing.reference);
            continue;
          }
          const key = randomUUID();
          const directory = join(inputs, key);
          let original: Attachment = attachment;
          let byteLength: number;
          let mimeType: string;
          if (attachment.kind === "file" || attachment.kind === "text") {
            const bytes =
              attachment.kind === "file"
                ? yield* io("snapshot", async () => {
                    if ((await stat(attachment.path)).size > MAX_PASTED_TEXT_BYTES)
                      throw new Error("Too large");
                    return readFile(attachment.path);
                  })
                : Buffer.from(attachment.text, "utf8");
            if (bytes.length > MAX_PASTED_TEXT_BYTES) return yield* failure("snapshot");
            const path = join(
              directory,
              "input" +
                (attachment.kind === "text" ? ".txt" : extname(attachment.path).slice(0, 32)),
            );
            yield* io("snapshot", async () => {
              await mkdir(directory, { mode: 0o700 });
              await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
            });
            original = { kind: "file", name: attachment.name, path };
            byteLength = bytes.length;
            mimeType = attachment.kind === "text" ? "text/plain" : "application/octet-stream";
          } else {
            byteLength =
              attachment.kind === "image"
                ? Buffer.from(attachment.data, "base64").length
                : Buffer.byteLength(JSON.stringify(attachment));
            mimeType = attachment.kind === "image" ? attachment.mimeType : "application/json";
          }
          const reference: TaskInputReference = {
            kind: "input",
            id: key,
            name: "name" in attachment ? attachment.name : "Annotations",
            mimeType,
            byteLength,
          };
          yield* io("snapshot", () => mkdir(directory, { recursive: true, mode: 0o700 }));
          if (attachment.kind === "image") {
            const originalPath = join(
              directory,
              `original-image${imageExtension.get(attachment.mimeType) ?? ".bin"}`,
            );
            yield* io("snapshot", () =>
              writeFile(originalPath, Buffer.from(attachment.data, "base64"), {
                flag: "wx",
                mode: 0o600,
              }),
            );
            original = { ...attachment, originalPath };
          }
          yield* atomic(join(directory, "payload.json"), original);
          // Publish bounded metadata only after the complete original is stored.
          // Authorization and forwarding never open payload.json.
          yield* atomic(join(inputs, `${key}.json`), { ownerSessionId, reference });
          result.push(reference);
        }
        return result;
      });
      const authorizeForward = Effect.fn("TaskInputStorage.authorizeForward")(function* (
        ownerSessionId: string,
        ids: readonly string[],
        targetSessionId?: string,
      ) {
        if (ids.length > 20 || new Set(ids).size !== ids.length)
          return yield* failure("authorizeForward");
        if (!ids.length) return [];
        if (targetSessionId !== undefined) yield* id(targetSessionId);
        for (const value of ids) {
          const input = yield* stored(value);
          if (input.ownerSessionId !== ownerSessionId) return yield* failure("authorizeForward");
        }
        const token = randomUUID();
        yield* atomic(join(grants, `${token}.json`), {
          ownerSessionId,
          ids,
          recipientSessionId: targetSessionId ?? null,
          createdAt: yield* Clock.currentTimeMillis,
        });
        return ids.map((value) => `${value}/${token}`);
      });
      const resolve = Effect.fn("TaskInputStorage.resolve")(
        (recipientSessionId: string, attachments: readonly Attachment[]) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const result: Attachment[] = [];
              for (const attachment of attachments) {
                if (attachment.kind === "input") return yield* failure("resolve");
                if (attachment.kind === "text") {
                  // Ordinary sessions get a readable file, not an unbounded prompt expansion.
                  const [reference] = yield* isolate(recipientSessionId, [attachment]);
                  if (!reference) return yield* failure("resolve");
                  result.push(yield* payload(reference.id));
                  continue;
                }
                if (attachment.kind !== "forwarded-input") {
                  result.push(attachment);
                  continue;
                }
                const value = yield* Schema.decodeUnknownEffect(ForwardReference)(
                  attachment.reference,
                ).pipe(Effect.mapError(() => failure("resolve")));
                const [key, token] = value.split("/");
                if (!key || !token) return yield* failure("resolve");
                yield* id(key);
                yield* id(token);
                yield* id(recipientSessionId);
                const grantPath = join(grants, `${token}.json`);
                const grant = yield* read(grantPath, Grant);
                if (
                  grant.recipientSessionId === null &&
                  (yield* Clock.currentTimeMillis) - grant.createdAt > 10 * 60 * 1000
                )
                  return yield* failure("resolve");
                const input = yield* stored(key);
                if (
                  !grant.ids.includes(key) ||
                  grant.ownerSessionId !== input.ownerSessionId ||
                  (grant.recipientSessionId !== null &&
                    grant.recipientSessionId !== recipientSessionId)
                )
                  return yield* failure("resolve");
                const original = yield* payload(key);
                if (grant.recipientSessionId === null)
                  yield* atomic(grantPath, { ...grant, recipientSessionId });
                yield* atomic(join(recipients, `${recipientSessionId}.json`), true);
                result.push(original);
              }
              return result;
            }),
          ),
      );
      const isRecipient = Effect.fn("TaskInputStorage.isRecipient")(function* (sessionId: string) {
        if (Option.isNone(Schema.decodeUnknownOption(TaskInputReference.fields.id)(sessionId)))
          return false;
        return yield* io("isRecipient", async () => {
          try {
            await readFile(join(recipients, `${sessionId}.json`));
            return true;
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
            throw cause;
          }
        });
      });
      const protectRecipient = Effect.fn("TaskInputStorage.protectRecipient")(function* (
        sessionId: string,
      ) {
        yield* id(sessionId);
        yield* atomic(join(recipients, `${sessionId}.json`), true);
      });
      return TaskInputStorage.of({
        isolate,
        authorizeForward,
        resolve,
        isRecipient,
        protectRecipient,
      });
    }),
  );
