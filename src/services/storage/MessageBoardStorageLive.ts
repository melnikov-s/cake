import { createHash } from "node:crypto";
import { DateTime, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import {
  BoardAppendInput,
  BoardEntry,
  BoardReceipt,
  MessageBoardError,
} from "../../contracts/artifacts/message-board";
import { MessageBoardStorage } from "./MessageBoardStorage";
import { atomicWriteFile } from "./internal/atomicFile";

const error = (operation: string, cause: unknown) =>
  new MessageBoardError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
const ReceiptDocument = Schema.Struct({
  version: Schema.Literal(1),
  receipts: Schema.Array(BoardReceipt),
});
const EntryDocument = Schema.Struct({ version: Schema.Literal(1), entry: BoardEntry });

/** One backend owns the directory and serializes append/receipt mutations. Each entry is written once. */
export const makeMessageBoardStorageLive = (artifactRoot: string) =>
  Layer.effect(
    MessageBoardStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const directory = (id: ArtifactLineageId) =>
        path.join(artifactRoot, "boards", createHash("sha256").update(id).digest("hex"));
      const entryDirectory = (id: ArtifactLineageId) => path.join(directory(id), "entries");
      const receiptPath = (id: ArtifactLineageId) => path.join(directory(id), "receipts.json");
      const write = (
        target: string,
        data: typeof EntryDocument.Type | typeof ReceiptDocument.Type,
      ) =>
        atomicWriteFile(fs, path, target, `${JSON.stringify(data)}\n`, (stage, cause) =>
          error(`write:${stage}`, cause),
        );
      const entries = Effect.fn("MessageBoardStorage.entries")(function* (id: ArtifactLineageId) {
        yield* Schema.decodeUnknownEffect(ArtifactLineageId)(id).pipe(
          Effect.mapError((cause) => error("entries", cause)),
        );
        const dir = entryDirectory(id);
        if (!(yield* fs.exists(dir).pipe(Effect.mapError((cause) => error("entries", cause)))))
          return [];
        const names = (yield* fs
          .readDirectory(dir)
          .pipe(Effect.mapError((cause) => error("entries", cause))))
          .filter((name) => /^[0-9]+\.json$/.test(name))
          .sort();
        return yield* Effect.forEach(
          names,
          Effect.fn("MessageBoardStorage.readEntry")(function* (name) {
            const text = yield* fs
              .readFileString(path.join(dir, name))
              .pipe(Effect.mapError((cause) => error("entries", cause)));
            const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EntryDocument))(
              text,
            ).pipe(Effect.mapError((cause) => error("entries", cause)));
            if (value.entry.sequence !== Number(name.slice(0, -5)))
              return yield* error("entries", "Entry sequence does not match filename");
            return value.entry;
          }),
        );
      });
      const receipts = Effect.fn("MessageBoardStorage.receipts")(function* (id: ArtifactLineageId) {
        const target = receiptPath(id);
        if (!(yield* fs.exists(target).pipe(Effect.mapError((cause) => error("receipts", cause)))))
          return [];
        const text = yield* fs
          .readFileString(target)
          .pipe(Effect.mapError((cause) => error("receipts", cause)));
        return (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiptDocument))(
          text,
        ).pipe(Effect.mapError((cause) => error("receipts", cause)))).receipts;
      });
      const append = Effect.fn("MessageBoardStorage.append")(
        (id: ArtifactLineageId, authorSessionId: string, input: BoardAppendInput) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(BoardAppendInput)(input).pipe(
                Effect.mapError((cause) => error("append", cause)),
              );
              const all = yield* entries(id);
              if (decoded.supersedes) {
                if (!decoded.topic)
                  return yield* error("append", "Superseding an entry requires a topic");
                for (const sequence of decoded.supersedes) {
                  const previous = all.find((entry) => entry.sequence === sequence);
                  if (
                    !previous ||
                    (previous.topic !== undefined && previous.topic !== decoded.topic)
                  )
                    return yield* error(
                      "append",
                      `Entry #${sequence} must exist and be untagged or in the same topic`,
                    );
                }
              }
              const entry = yield* BoardEntry.makeEffect({
                ...decoded,
                audience: decoded.audience,
                sequence: (all.at(-1)?.sequence ?? 0) + 1,
                authorSessionId,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              }).pipe(Effect.mapError((cause) => error("append", cause)));
              yield* write(
                path.join(entryDirectory(id), `${String(entry.sequence).padStart(16, "0")}.json`),
                { version: 1, entry },
              );
              return entry;
            }),
          ),
      );
      const record = Effect.fn("MessageBoardStorage.record")(
        (
          id: ArtifactLineageId,
          sessionId: string,
          sequences: ReadonlyArray<number>,
          kind: "notifiedAt" | "readAt",
        ) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const all = yield* entries(id);
              const current = [...(yield* receipts(id))];
              const timestamp = DateTime.formatIso(yield* DateTime.now);
              let changed = false;
              for (const sequence of new Set(sequences)) {
                if (!all.some((entry) => entry.sequence === sequence))
                  return yield* error("record", `Unknown entry #${sequence}`);
                const index = current.findIndex(
                  (receipt) => receipt.sequence === sequence && receipt.sessionId === sessionId,
                );
                const previous = current[index];
                if (previous?.[kind] !== undefined) continue;
                const receipt = yield* BoardReceipt.makeEffect({
                  ...previous,
                  sequence,
                  sessionId,
                  [kind]: timestamp,
                }).pipe(Effect.mapError((cause) => error("record", cause)));
                if (index < 0) current.push(receipt);
                else current[index] = receipt;
                changed = true;
              }
              if (changed) yield* write(receiptPath(id), { version: 1, receipts: current });
            }),
          ),
      );
      return MessageBoardStorage.of({ append, entries, receipts, record });
    }),
  );
