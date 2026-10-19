import type * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect } from "effect";
import type { TaskInputReference } from "../../../../src/contracts/conversations/task-input";
import { TaskInputStorage } from "../../../../src/services/storage/TaskInputStorage";
import { makeTaskInputStorageLive } from "../../../../src/services/storage/TaskInputStorageLive";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof fsPromises>();
  return { ...fs, readFile: vi.fn(fs.readFile), readdir: vi.fn(fs.readdir) };
});

const owner = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
const child = "00000000-0000-4000-8000-000000000003";
const reference = (index: number): TaskInputReference => ({
  kind: "input",
  id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
  name: `Input ${index}`,
  mimeType: "text/plain",
  byteLength: 10,
});
const fixture = <A, E>(work: (root: string) => Effect.Effect<A, E, TaskInputStorage>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-input-list-"))),
    (root) => work(root).pipe(Effect.provide(makeTaskInputStorageLive(root))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );
const seed = (root: string, count: number) =>
  Effect.promise(() =>
    Promise.all(
      Array.from({ length: count }, (_, index) =>
        writeFile(
          join(root, "task-inputs", "inputs", `${reference(index).id}.json`),
          JSON.stringify({ ownerSessionId: owner, reference: reference(index) }),
        ),
      ),
    ),
  );
const resetReads = () => {
  vi.mocked(readFile).mockClear();
  vi.mocked(readdir).mockClear();
};
const readCounts = (root: string) => {
  const paths = vi.mocked(readFile).mock.calls.map(([path]) => String(path));
  return {
    metadata: paths.filter((path) => path.startsWith(join(root, "task-inputs", "inputs"))).length,
    access: paths.filter((path) => path.startsWith(join(root, "task-inputs", "access"))).length,
    payload: paths.filter((path) => path.endsWith("payload.json")).length,
    directories: vi.mocked(readdir).mock.calls.length,
  };
};

describe("task-input listing", () => {
  it.effect.each([false, true])(
    "sparseAccessibleInputsAvoidRepeatedSharedReads (has grants: %s)",
    (hasGrants) =>
      fixture((root) =>
        Effect.gen(function* () {
          const storage = yield* TaskInputStorage;
          yield* seed(root, 400);
          const expected = hasGrants ? [reference(10), reference(390)] : [];
          if (hasGrants) {
            const grants = yield* storage.authorizeForward(
              owner,
              expected.map((ref) => ref.id),
              target,
            );
            yield* storage.grant(target, grants);
          }
          resetReads();
          expect(yield* storage.list(target, { limit: 20 })).toEqual({
            references: expected,
            nextAfter: null,
          });
          expect(readCounts(root)).toEqual({
            metadata: 400,
            access: expected.length,
            payload: 0,
            directories: 2,
          });
        }),
      ),
  );

  it.effect("inaccessibleInputsRemainHidden, including invalid markers and cursors", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const storage = yield* TaskInputStorage;
        yield* seed(root, 5);
        const access = join(root, "task-inputs", "access", target);
        yield* Effect.promise(async () => {
          await mkdir(access, { recursive: true });
          await writeFile(join(access, `${reference(0).id}.json`), "false");
          await writeFile(join(access, `${reference(1).id}.json`), "garbage");
          await writeFile(join(access, `${reference(2).id}.json`), "true");
          await writeFile(join(root, "task-inputs", "inputs", `${reference(2).id}.json`), "{}");
        });
        expect(yield* storage.list(target, {})).toEqual({ references: [], nextAfter: null });
        expect((yield* Effect.result(storage.list(target, { after: reference(4).id })))._tag).toBe(
          "Failure",
        );
        expect((yield* Effect.result(storage.list(target, { after: reference(0).id })))._tag).toBe(
          "Failure",
        );
        expect(yield* storage.list(owner, { limit: 1 })).toEqual({
          references: [reference(0)],
          nextAfter: reference(0).id,
        });
      }),
    ),
  );

  it.effect("listingPaginationPreservesOrder across owned and forwarded inputs", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const storage = yield* TaskInputStorage;
        yield* seed(root, 8);
        const expected = [reference(1), reference(3), reference(4), reference(7)];
        yield* Effect.promise(() =>
          writeFile(
            join(root, "task-inputs", "inputs", `${reference(3).id}.json`),
            JSON.stringify({ ownerSessionId: target, reference: reference(3) }),
          ),
        );
        const grants = yield* storage.authorizeForward(
          owner,
          [reference(1).id, reference(4).id, reference(7).id],
          target,
        );
        yield* storage.grant(target, grants);
        resetReads();
        const first = yield* storage.list(target, { limit: 2 });
        expect(first).toEqual({ references: expected.slice(0, 2), nextAfter: reference(3).id });
        // Stop after the first extra authorized reference, not the global roster.
        expect(readCounts(root)).toEqual({ metadata: 5, access: 2, payload: 0, directories: 2 });
        expect(yield* storage.list(target, { limit: 2, after: reference(3).id })).toEqual({
          references: expected.slice(2),
          nextAfter: null,
        });
        expect(yield* storage.list(target, { after: reference(7).id })).toEqual({
          references: [],
          nextAfter: null,
        });
        // Inherited protection is not permission to discover a relative's inputs.
        yield* storage.protectRecipient(child);
        expect(yield* storage.list(child, {})).toEqual({ references: [], nextAfter: null });
        const forwarded = yield* storage.authorizeForward(target, [reference(1).id], child);
        yield* storage.grant(child, forwarded);
        expect(yield* storage.list(child, {})).toEqual({
          references: [reference(1)],
          nextAfter: null,
        });
        yield* Effect.gen(function* () {
          const restarted = yield* TaskInputStorage;
          expect(yield* restarted.list(target, {})).toEqual({
            references: expected,
            nextAfter: null,
          });
          expect(yield* restarted.list(child, {})).toEqual({
            references: [reference(1)],
            nextAfter: null,
          });
        }).pipe(Effect.provide(makeTaskInputStorageLive(root), { local: true }));
      }),
    ),
  );
});
