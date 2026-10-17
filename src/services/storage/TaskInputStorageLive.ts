import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type {
  AttachmentReadInput,
  AttachmentReferenceQuery,
} from "../../contracts/conversations/attachment-reference-control";
import { Clock, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { attachmentSchema, type Attachment } from "../../contracts/conversations/session-contract";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import {
  TaskInputReference,
  MAX_PASTED_TEXT_BYTES,
} from "../../contracts/conversations/task-input";
import { AttachmentUploadError } from "../../contracts/filesystem/attachment-uploads-errors";
import { TaskInputStorage } from "./TaskInputStorage";

// Project Chats have stable non-UUID addresses. Keep every accepted key path-safe.
const SessionKey = Schema.Union([
  Schema.String.check(Schema.isUUID()),
  Schema.String.check(Schema.makeFilter(isCakeChatSessionId)),
]);
const StoredInput = Schema.Struct({
  ownerSessionId: Schema.String,
  reference: TaskInputReference,
});
const Grant = Schema.Struct({
  ownerSessionId: Schema.String,
  ids: Schema.Array(Schema.String.check(Schema.isUUID(4))),
  recipientSessionId: Schema.NullOr(SessionKey),
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
const fileMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  ...[
    ".txt",
    ".md",
    ".csv",
    ".log",
    ".yaml",
    ".yml",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".html",
    ".css",
    ".svg",
    ".xml",
    ".sh",
    ".toml",
    ".sql",
  ].map((extension): [string, string] => [extension, "text/plain"]),
]);
const failure = (
  operation: string,
  message = "Task input is unavailable, unauthorized, or exceeds its size limit",
) => new AttachmentUploadError({ operation, message });

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
      const access = join(root, "access");
      yield* Effect.promise(() =>
        Promise.all(
          [inputs, grants, recipients, access].map((path) =>
            mkdir(path, { recursive: true, mode: 0o700 }),
          ),
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
      const sessionKey = (value: string) =>
        Schema.decodeUnknownEffect(SessionKey)(value).pipe(
          Effect.mapError(() => failure("sessionId")),
        );
      const stored = Effect.fn("TaskInputStorage.stored")(function* (value: string) {
        const key = yield* id(value);
        return yield* read(join(inputs, `${key}.json`), StoredInput);
      });
      const payload = Effect.fn("TaskInputStorage.payload")(function* (value: string) {
        const key = yield* id(value);
        return yield* read(join(inputs, key, "payload.json"), attachmentSchema);
      });
      const allow = Effect.fn("TaskInputStorage.allow")(function* (sessionId: string, key: string) {
        yield* sessionKey(sessionId);
        yield* id(key);
        const directory = join(access, sessionId);
        yield* io("grant", () => mkdir(directory, { recursive: true, mode: 0o700 }));
        yield* atomic(join(directory, `${key}.json`), true);
      });
      const authorized = Effect.fn("TaskInputStorage.authorized")(function* (
        sessionId: string,
        key: string,
      ) {
        yield* sessionKey(sessionId);
        const input = yield* stored(key);
        if (input.ownerSessionId === sessionId) return input;
        const allowed = yield* io("authorize", async () => {
          try {
            return (await readFile(join(access, sessionId, `${key}.json`), "utf8")) === "true";
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
            throw cause;
          }
        });
        if (!allowed) return yield* failure("authorize");
        return input;
      });
      // Storage migration: older accepted forwards persisted bound grants, but no
      // recipient lookup index. Rebuild only access metadata, never transcript or payloads.
      const migrationPath = join(root, "access-index-v1.json");
      const indexed = yield* io("migrateAccess", async () => {
        try {
          return (await readFile(migrationPath, "utf8")) === "true";
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
          throw cause;
        }
      });
      if (!indexed) {
        const files = yield* io("migrateAccess", () => readdir(grants));
        for (const file of files.filter((name) => name.endsWith(".json"))) {
          const permission = yield* read(join(grants, file), Grant).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (!permission?.recipientSessionId) continue;
          for (const key of permission.ids) yield* allow(permission.recipientSessionId, key);
        }
        yield* atomic(migrationPath, true);
      }
      const isolate = Effect.fn("TaskInputStorage.isolate")(function* (
        ownerSessionId: string,
        attachments: readonly Attachment[],
      ) {
        yield* sessionKey(ownerSessionId);
        const result: TaskInputReference[] = [];
        for (const attachment of attachments) {
          if (attachment.kind === "forwarded-input") {
            result.push(...(yield* grant(ownerSessionId, [attachment.reference])));
            continue;
          }
          if (attachment.kind === "input") {
            const existing = yield* authorized(ownerSessionId, attachment.id);
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
            mimeType =
              attachment.kind === "text"
                ? "text/plain"
                : (fileMimeTypes.get(extname(attachment.name).toLowerCase()) ??
                  "application/octet-stream");
          } else {
            byteLength =
              attachment.kind === "image"
                ? Buffer.from(attachment.data, "base64").length
                : Buffer.byteLength(JSON.stringify(attachment));
            mimeType = attachment.kind === "image" ? attachment.mimeType : "application/json";
          }
          if (byteLength > MAX_PASTED_TEXT_BYTES) return yield* failure("snapshot");
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
          yield* atomic(join(directory, "payload.json"), {
            ...original,
            inputReference: reference,
          });
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
        if (targetSessionId !== undefined) yield* sessionKey(targetSessionId);
        for (const value of ids) {
          yield* authorized(ownerSessionId, value);
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
      const bind = Effect.fn("TaskInputStorage.bind")(function* (
        recipientSessionId: string,
        reference: string,
      ) {
        const value = yield* Schema.decodeUnknownEffect(ForwardReference)(reference).pipe(
          Effect.mapError(() => failure("grant")),
        );
        const [key, token] = value.split("/");
        if (!key || !token) return yield* failure("grant");
        yield* id(key);
        yield* id(token);
        yield* sessionKey(recipientSessionId);
        const grantPath = join(grants, `${token}.json`);
        const permission = yield* read(grantPath, Grant);
        if (
          (permission.recipientSessionId === null &&
            (yield* Clock.currentTimeMillis) - permission.createdAt > 10 * 60 * 1000) ||
          !permission.ids.includes(key) ||
          (permission.recipientSessionId !== null &&
            permission.recipientSessionId !== recipientSessionId)
        )
          return yield* failure("grant");
        const input = yield* stored(key);
        if (permission.recipientSessionId === null)
          yield* atomic(grantPath, { ...permission, recipientSessionId });
        yield* allow(recipientSessionId, key);
        yield* atomic(join(recipients, `${recipientSessionId}.json`), true);
        return input.reference;
      });
      const grant = Effect.fn("TaskInputStorage.grant")(
        (recipientSessionId: string, references: readonly string[]) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (references.length > 20) return yield* failure("grant");
              return yield* Effect.forEach(references, (reference) =>
                bind(recipientSessionId, reference),
              );
            }),
          ),
      );
      const list = Effect.fn("TaskInputStorage.list")(function* (
        sessionId: string,
        query: AttachmentReferenceQuery,
      ) {
        yield* sessionKey(sessionId);
        const keys = (yield* io("list", () => readdir(inputs)))
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -5))
          .sort();
        const references: TaskInputReference[] = [];
        const limit = Math.min(100, Math.max(1, query.limit ?? 20));
        if (query.after) yield* authorized(sessionId, query.after);
        for (const key of keys) {
          if (query.after && key <= query.after) continue;
          const input = yield* authorized(sessionId, key).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (input) references.push(input.reference);
          if (references.length > limit) break;
        }
        const hasMore = references.length > limit;
        if (hasMore) references.pop();
        return { references, nextAfter: hasMore ? (references.at(-1)?.id ?? null) : null };
      });
      const inspect = Effect.fn("TaskInputStorage.inspect")(function* (
        sessionId: string,
        request: AttachmentReadInput,
      ) {
        const { reference } = yield* authorized(sessionId, request.reference);
        const original = yield* payload(reference.id);
        let bytes: Buffer | undefined;
        if (original.kind === "file") {
          bytes = yield* io("inspect", async () => {
            const path = await realpath(original.path);
            if (
              dirname(path) !== (await realpath(join(inputs, reference.id))) ||
              (await stat(path)).size > MAX_PASTED_TEXT_BYTES
            )
              throw new Error("Not a pinned input");
            return readFile(path);
          });
        }
        const mimeType =
          reference.mimeType === "application/octet-stream"
            ? (fileMimeTypes.get(extname(reference.name).toLowerCase()) ?? reference.mimeType)
            : reference.mimeType;
        if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") {
          if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType))
            return yield* failure(
              "inspect",
              "Unsupported image type. Supported types: PNG, JPEG, GIF and WebP.",
            );
          const imageMime = yield* Schema.decodeUnknownEffect(
            Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
          )(mimeType).pipe(Effect.mapError(() => failure("inspect")));
          const data = original.kind === "image" ? original.data : bytes?.toString("base64");
          if (!data || Buffer.from(data, "base64").length > 8_000_000)
            return yield* failure("inspect", "Image exceeds the 8 MB inspection limit.");
          return { kind: "image" as const, reference, mimeType: imageMime, data };
        }
        if (!(mimeType.startsWith("text/") || mimeType === "application/json"))
          return yield* failure(
            "inspect",
            "Unsupported attachment type. Read supports UTF-8 text/JSON and PNG, JPEG, GIF or WebP images; forward other files to a Project Session.",
          );
        const text = bytes
          ? yield* io("inspect", async () =>
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            ).pipe(
              Effect.mapError(() =>
                failure(
                  "inspect",
                  "The attachment is not valid UTF-8 text. Forward it to a Project Session for format-specific inspection.",
                ),
              ),
            )
          : original.kind === "text"
            ? original.text
            : JSON.stringify(original);
        const offset = request.offset ?? 0;
        const limit = request.limit ?? 16_000;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > text.length ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 48_000
        )
          return yield* failure(
            "inspect",
            "Invalid text range. Offset must be within the attachment and limit between 1 and 48000 characters.",
          );
        const end = Math.min(text.length, offset + limit);
        return {
          kind: "text" as const,
          reference,
          text: text.slice(offset, end),
          offset,
          totalCharacters: text.length,
          nextOffset: end < text.length ? end : null,
        };
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
                  const [reference] = yield* isolate(recipientSessionId, [attachment]);
                  if (!reference) return yield* failure("resolve");
                  result.push(yield* payload(reference.id));
                  continue;
                }
                const reference = yield* bind(recipientSessionId, attachment.reference);
                result.push(yield* payload(reference.id));
              }
              return result;
            }),
          ),
      );
      const isRecipient = Effect.fn("TaskInputStorage.isRecipient")(function* (sessionId: string) {
        if (Option.isNone(Schema.decodeUnknownOption(SessionKey)(sessionId))) return false;
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
        yield* sessionKey(sessionId);
        yield* atomic(join(recipients, `${sessionId}.json`), true);
      });
      return TaskInputStorage.of({
        isolate,
        authorizeForward,
        resolve,
        grant,
        list,
        inspect,
        isRecipient,
        protectRecipient,
      });
    }),
  );
