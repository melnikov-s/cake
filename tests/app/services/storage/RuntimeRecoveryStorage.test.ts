import { it } from "@effect/vitest";
import { join } from "node:path";
import { recoveryRecordFileName } from "../../../../src/services/storage/internal/recoveryRecordFiles";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, FileSystem, Layer, Path, PlatformError, Ref } from "effect";
import { describe, expect } from "vitest";
import {
  makeRuntimeRecoveryStorageLive,
  RuntimeRecoveryStorage,
  type RuntimeRecoveryRecord,
} from "../../../../src/services/storage/RuntimeRecoveryStorage";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const recordFile = (directory: string, sessionId: string) =>
  join(directory, "recovery-intents", recoveryRecordFileName(sessionId));
const record: RuntimeRecoveryRecord = {
  sessionId: "project-session",
  workingDirectory: "/project",
  sessionDirectory: "/pi/sessions/project",
  profile: "ProjectSession",
  transcriptPersisted: true,
  inputs: [
    {
      turnId: "turn-1",
      text: "Continue implementing",
      delivery: "prompt",
      attachments: [{ kind: "file", name: "notes.txt", path: "/project/notes.txt" }],
      markdown: true,
      presentationMode: "vscode",
      responseMode: "text",
      automaticTitle: true,
    },
    {
      turnId: "turn-2",
      text: "Consider this first",
      delivery: "steer",
      attachments: [{ kind: "text", name: "context", text: "A recovery envelope" }],
      markdown: false,
      presentationMode: "browser",
      responseMode: "voice",
    },
    {
      turnId: "turn-3",
      text: "Then run tests",
      delivery: "follow-up",
      attachments: [],
      markdown: false,
    },
  ],
  state: "active",
};

const withDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-runtime-recovery-" });
    return yield* use(directory);
  }).pipe(Effect.scoped, Effect.provide(platform));

const open = <A, E>(
  directory: string,
  use: (storage: RuntimeRecoveryStorage["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(RuntimeRecoveryStorage, use).pipe(
    Effect.provide(makeRuntimeRecoveryStorageLive(directory)),
  );

const list = (directory: string) => open(directory, (storage) => storage.list());

describe("RuntimeRecoveryStorage", () => {
  it.effect("reopens durable input envelopes from the same versioned file", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        expect(yield* list(directory)).toEqual([]);
        yield* open(directory, (storage) => storage.update(record));
        expect(yield* list(directory)).toEqual([record]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        expect(
          JSON.parse(yield* fs.readFileString(recordFile(directory, record.sessionId))),
        ).toEqual({
          version: 1,
          data: record,
        });
        expect(yield* fs.readDirectory(path.join(directory, "recovery-intents"))).toEqual([
          recoveryRecordFileName(record.sessionId),
        ]);
      }),
    ),
  );

  it.effect(
    "loads lazily once per service and serves reads and mutations from committed state",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          yield* open(directory, (storage) => storage.update(record));
          const fs = yield* FileSystem.FileSystem;
          const reads = yield* Ref.make(0);
          const countedFs: FileSystem.FileSystem = {
            ...fs,
            readFileString: (file, encoding) =>
              Ref.update(reads, (count) => count + 1).pipe(
                Effect.andThen(fs.readFileString(file, encoding)),
              ),
          };
          yield* open(directory, (storage) =>
            Effect.gen(function* () {
              expect(yield* Ref.get(reads)).toBe(0);
              const loaded = yield* Effect.all(
                Array.from({ length: 10 }, () => storage.list()),
                {
                  concurrency: "unbounded",
                },
              );
              expect(loaded).toEqual(Array.from({ length: 10 }, () => [record]));
              expect(yield* Ref.get(reads)).toBe(1);
              const updated: RuntimeRecoveryRecord = {
                ...record,
                state: "blocked",
                issue: "Retry",
              };
              yield* storage.update(updated);
              expect(yield* storage.list()).toEqual([updated]);
              yield* storage.remove(record.sessionId);
              expect(yield* storage.list()).toEqual([]);
              expect(yield* Ref.get(reads)).toBe(1);
            }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, countedFs));
          expect(yield* list(directory)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "reads and replaces only the target record, regardless of historical journal size",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* open(directory, (storage) =>
            Effect.forEach(
              Array.from({ length: 100 }, (_, index) => ({
                ...record,
                sessionId: `session-${index}`,
              })),
              storage.update,
            ),
          );
          const readPaths: string[] = [];
          const writes: string[] = [];
          const countedFs: FileSystem.FileSystem = {
            ...fs,
            readFileString: (file, encoding) =>
              Effect.sync(() => readPaths.push(file)).pipe(
                Effect.andThen(fs.readFileString(file, encoding)),
              ),
            writeFileString: (file, content, options) =>
              Effect.sync(() => writes.push(content)).pipe(
                Effect.andThen(fs.writeFileString(file, content, options)),
              ),
          };
          yield* open(directory, (storage) =>
            Effect.gen(function* () {
              const original = yield* storage.get("session-0");
              expect(original?.sessionId).toBe("session-0");
              yield* storage.update({
                ...record,
                sessionId: "session-0",
                state: "complete",
                inputs: [],
              });
              expect(readPaths).toEqual([recordFile(directory, "session-0")]);
              expect(writes).toHaveLength(1);
              expect(JSON.parse(writes.join("")).data.sessionId).toBe("session-0");
              expect(writes[0]).not.toContain("session-99");
              expect((yield* storage.list()).length).toBe(100);
            }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, countedFs));
        }),
      ),
  );

  it.effect("isolates a malformed record from healthy sessions without overwriting evidence", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(join(directory, "recovery-intents"));
        const file = recordFile(directory, "broken");
        yield* fs.writeFileString(file, "{bad json");
        yield* open(directory, (storage) =>
          Effect.gen(function* () {
            yield* storage.update(record);
            expect(yield* storage.get(record.sessionId)).toEqual(record);
            const failure = yield* Effect.flip(storage.list());
            expect(failure.message).toContain(file);
            expect(yield* storage.get(record.sessionId)).toEqual(record);
          }),
        );
        expect(yield* fs.readFileString(file)).toBe("{bad json");
      }),
    ),
  );

  it.effect("serializes concurrent updates without losing other session records", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const records = Array.from({ length: 20 }, (_, index) => ({
          ...record,
          sessionId: `session-${index}`,
        }));
        yield* open(directory, (storage) =>
          Effect.all(
            records.map((item) => storage.update(item)),
            { concurrency: "unbounded" },
          ),
        );
        const saved = yield* list(directory);
        expect(saved).toHaveLength(records.length);
        expect(new Set(saved.map((item) => item.sessionId))).toEqual(
          new Set(records.map((item) => item.sessionId)),
        );
      }),
    ),
  );

  it.effect("replaces a session intent and retains blocked state until explicitly removed", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* open(directory, (storage) => storage.update(record));
        const blocked: RuntimeRecoveryRecord = {
          ...record,
          inputs: record.inputs.slice(1),
          state: "blocked",
          issue: "Provider credentials need attention",
        };
        yield* open(directory, (storage) => storage.update(blocked));
        expect(yield* list(directory)).toEqual([blocked]);
        expect(yield* list(directory)).toEqual([blocked]);
        yield* open(directory, (storage) => storage.remove(record.sessionId));
        expect(yield* list(directory)).toEqual([]);
      }),
    ),
  );

  it.effect.each(["complete", "failed", "stopped"] as const)(
    "reopens a terminal %s outcome without retaining consumed inputs",
    (state) =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          yield* open(directory, (storage) => storage.update(record));
          const terminal: RuntimeRecoveryRecord = {
            ...record,
            state,
            inputs: [],
            ...(state === "failed" ? { issue: "Provider rejected the request" } : {}),
          };
          yield* open(directory, (storage) => storage.update(terminal));
          expect(yield* list(directory)).toEqual([terminal]);
          expect(yield* list(directory)).toEqual([terminal]);
        }),
      ),
  );

  it.effect("serializes removal with updates and leaves unrelated records intact", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const other: RuntimeRecoveryRecord = {
          ...record,
          sessionId: "cake-chat",
          profile: "CakeChatSession",
        };
        yield* open(directory, (storage) => storage.update(record));
        yield* open(directory, (storage) =>
          Effect.all([storage.remove(record.sessionId), storage.update(other)], {
            concurrency: "unbounded",
          }),
        );
        expect(yield* list(directory)).toEqual([other]);
        yield* open(directory, (storage) => storage.remove("missing-session"));
        expect(yield* list(directory)).toEqual([other]);
      }),
    ),
  );

  it.effect.each([
    { name: "invalid JSON", content: "{bad json" },
    { name: "unversioned document", content: JSON.stringify({ data: record }) },
    { name: "future version", content: JSON.stringify({ version: 2, data: record }) },
    {
      name: "mismatched identity",
      content: JSON.stringify({ version: 1, data: { ...record, sessionId: "another-session" } }),
    },
    {
      name: "invalid record",
      content: JSON.stringify({ version: 1, data: { ...record, state: "done" } }),
    },
    {
      name: "invalid input",
      content: JSON.stringify({
        version: 1,
        data: { ...record, inputs: [{ text: "incomplete" }] },
      }),
    },
  ])("rejects $name without overwriting recovery evidence", ({ content }) =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = recordFile(directory, record.sessionId);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, content);
        yield* open(directory, (storage) =>
          Effect.gen(function* () {
            for (const operation of [
              storage.list(),
              storage.get(record.sessionId),
              storage.update(record),
              storage.remove(record.sessionId),
            ]) {
              const error = yield* Effect.flip(operation);
              expect(error._tag).toBe("RuntimeRecoveryStorageError");
              expect(error.operation).toBe("decode");
            }
          }),
        );
        expect(yield* fs.readFileString(file)).toBe(content);
      }),
    ),
  );

  it.effect("keeps the last successful save after an atomic replacement fails", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* open(directory, (storage) => storage.update(record));
        const fs = yield* FileSystem.FileSystem;
        const failRename = yield* Ref.make(true);
        const failingFs: FileSystem.FileSystem = {
          ...fs,
          rename: (source, target) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(failRename, false)) {
                return yield* PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                });
              }
              return yield* fs.rename(source, target);
            }),
        };
        const updated: RuntimeRecoveryRecord = { ...record, state: "blocked", issue: "Retry me" };
        yield* open(directory, (storage) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(storage.update(updated));
            expect(error.operation).toBe("rename");
            expect(yield* storage.list()).toEqual([record]);
            yield* storage.update(updated);
            expect(yield* storage.list()).toEqual([updated]);
          }),
        ).pipe(Effect.provideService(FileSystem.FileSystem, failingFs));
        expect(yield* list(directory)).toEqual([updated]);
        expect(yield* fs.readDirectory(join(directory, "recovery-intents"))).toEqual([
          recoveryRecordFileName(record.sessionId),
        ]);
      }),
    ),
  );
});
