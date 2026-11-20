import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import { WorkspaceFiles } from "../../../../src/services/filesystem/WorkspaceFiles";
import { makeWorkspaceFilesLive } from "../../../../src/services/filesystem/WorkspaceFilesLive";
import type { WorkspaceFileError } from "../../../../src/contracts/filesystem/workspace-files-errors";
import { fakeProjectAccess } from "../../../helpers/fakes/projectAccess";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open), readFile: vi.fn(fs.readFile) };
});

const maxLength = 2_000_000;
const workspaceFilesLayer = makeWorkspaceFilesLive("/agent", "/cake-chat").pipe(
  Layer.provide(fakeProjectAccess({ isAllowed: () => Effect.succeed(true) })),
);

const withWorkspace = (
  test: (workspace: string) => Effect.Effect<void, WorkspaceFileError, WorkspaceFiles>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-workspace-text-"))),
    (workspace) => test(workspace).pipe(Effect.provide(workspaceFilesLayer)),
    (workspace) => Effect.promise(() => rm(workspace, { recursive: true, force: true })),
  );

// Observe real handle reads, optionally changing the actual file after a read.
async function observeNextOpen(afterRead?: () => Promise<void>) {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let totalBytesRead = 0;
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await fs.open(...args);
    handles.push(handle);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...args) => {
      const result = await read(...args);
      totalBytesRead += result.bytesRead;
      await afterRead?.();
      return result;
    });
    vi.spyOn(handle, "close");
    return handle;
  });
  return {
    handles,
    get totalBytesRead() {
      return totalBytesRead;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(open).mockClear();
  vi.mocked(readFile).mockClear();
});

describe("workspace text reads", () => {
  it.effect("returns ordinary, empty and exact-limit files without truncation", () =>
    withWorkspace((workspace) =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        for (const content of ["", "workspace text\nsecond line", "a".repeat(maxLength)]) {
          yield* Effect.promise(() => writeFile(join(workspace, "file.txt"), content));
          expect(yield* files.readFile(1, { workspacePath: workspace, path: "file.txt" })).toEqual({
            content,
          });
        }
        expect(readFile).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("counts decoded UTF-16 code units, not UTF-8 bytes or Unicode code points", () =>
    withWorkspace((workspace) =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        for (const content of [
          // Three-byte UTF-8 and supplementary characters split across 64 KiB reads.
          "a".repeat(65_535) + "€" + "b".repeat(maxLength - 65_536),
          "a".repeat(65_535) + "😀" + "b".repeat(maxLength - 65_537),
          "€".repeat(maxLength),
          "😀".repeat(maxLength / 2),
          // The final sequence requires multiple reads when only one code unit remains.
          "a".repeat(maxLength - 1) + "€",
          "a".repeat(maxLength - 2) + "😀",
        ]) {
          expect(content.length).toBe(maxLength);
          expect(Buffer.byteLength(content)).toBeGreaterThan(maxLength);
          yield* Effect.promise(() => writeFile(join(workspace, "unicode.txt"), content));
          expect(
            yield* files.readFile(1, { workspacePath: workspace, path: "unicode.txt" }),
          ).toEqual({ content });
          yield* Effect.promise(() => appendFile(join(workspace, "unicode.txt"), "x"));
          expect(
            yield* Effect.result(
              files.readFile(1, { workspacePath: workspace, path: "unicode.txt" }),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: { operation: "readFile", message: "File is too large to display" },
          });
        }
        // One emoji exceeds the limit by one UTF-16 code unit, despite being one code point.
        yield* Effect.promise(() =>
          writeFile(join(workspace, "unicode.txt"), "a".repeat(maxLength - 1) + "😀"),
        );
        expect(
          yield* Effect.result(
            files.readFile(1, { workspacePath: workspace, path: "unicode.txt" }),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { operation: "readFile", message: "File is too large to display" },
        });
      }),
    ),
  );

  it.effect(
    "preserves BOMs and malformed UTF-8 replacement, including incomplete EOF sequences",
    () =>
      withWorkspace((workspace) =>
        Effect.gen(function* () {
          const files = yield* WorkspaceFiles;
          for (const bytes of [
            Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0xe2, 0x82]),
            Buffer.concat([Buffer.alloc(65_535, 0x61), Buffer.from([0xe2, 0x82, 0x61])]),
            Buffer.concat([Buffer.alloc(maxLength - 1, 0x61), Buffer.from([0xe2, 0x82])]),
            Buffer.concat([Buffer.alloc(maxLength, 0x61), Buffer.from([0xe2, 0x82])]),
          ]) {
            yield* Effect.promise(() => writeFile(join(workspace, "invalid.txt"), bytes));
            const expected = bytes.toString("utf8");
            const result = yield* Effect.result(
              files.readFile(1, { workspacePath: workspace, path: "invalid.txt" }),
            );
            if (expected.length <= maxLength)
              expect(result).toMatchObject({ _tag: "Success", success: { content: expected } });
            else
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { operation: "readFile", message: "File is too large to display" },
              });
          }
        }),
      ),
  );

  it.effect(
    "rejects oversized files before reading all bytes or allocating a whole-file buffer",
    () =>
      withWorkspace((workspace) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(join(workspace, "large.txt"), Buffer.alloc(maxLength * 2, 0x61)),
          );
          const observed = yield* Effect.promise(() => observeNextOpen());
          const files = yield* WorkspaceFiles;
          expect(
            yield* Effect.result(
              files.readFile(1, { workspacePath: workspace, path: "large.txt" }),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: { operation: "readFile", message: "File is too large to display" },
          });
          expect(readFile).not.toHaveBeenCalled();
          expect(observed.totalBytesRead).toBe(maxLength + 1);
          expect(observed.handles).toHaveLength(1);
          for (const handle of observed.handles) {
            for (const [buffer] of vi.mocked(handle.read).mock.calls)
              expect(buffer).toHaveLength(64 * 1_024);
            expect(handle.close).toHaveBeenCalledOnce();
            expect(handle.fd).toBe(-1);
          }
        }),
      ),
  );

  it.effect("detects file growth during reading and closes the handle on rejection", () =>
    withWorkspace((workspace) =>
      Effect.gen(function* () {
        const path = join(workspace, "growing.txt");
        yield* Effect.promise(() => writeFile(path, "a".repeat(64 * 1_024)));
        let grown = false;
        const observed = yield* Effect.promise(() =>
          observeNextOpen(async () => {
            if (grown) return;
            grown = true;
            await appendFile(path, Buffer.alloc(maxLength * 2, 0x61));
          }),
        );
        const files = yield* WorkspaceFiles;
        expect(
          yield* Effect.result(
            files.readFile(1, { workspacePath: workspace, path: "growing.txt" }),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { operation: "readFile", message: "File is too large to display" },
        });
        expect(grown).toBe(true);
        expect(observed.totalBytesRead).toBe(maxLength + 1);
        for (const handle of observed.handles) {
          expect(handle.close).toHaveBeenCalledOnce();
          expect(handle.fd).toBe(-1);
        }
      }),
    ),
  );

  it.effect("preserves path and I/O errors and closes successfully opened handles", () =>
    withWorkspace((workspace) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(join(workspace, "directory")));
        yield* Effect.promise(() => writeFile(join(workspace, "file.txt"), "text"));
        yield* Effect.promise(() => symlink(tmpdir(), join(workspace, "outside")));
        const files = yield* WorkspaceFiles;
        for (const path of ["missing.txt", "directory", "outside", join(workspace, "file.txt")]) {
          expect(
            yield* Effect.result(files.readFile(1, { workspacePath: workspace, path })),
          ).toMatchObject({ _tag: "Failure", failure: { operation: "readFile" } });
        }
        const observed = yield* Effect.promise(() =>
          observeNextOpen(async () => {
            throw new Error("injected read failure");
          }),
        );
        expect(
          yield* Effect.result(files.readFile(1, { workspacePath: workspace, path: "file.txt" })),
        ).toMatchObject({
          _tag: "Failure",
          failure: { operation: "readFile", message: "injected read failure" },
        });
        for (const handle of observed.handles) {
          expect(handle.close).toHaveBeenCalledOnce();
          expect(handle.fd).toBe(-1);
        }
        const success = yield* Effect.promise(() => observeNextOpen());
        expect(yield* files.readFile(1, { workspacePath: workspace, path: "file.txt" })).toEqual({
          content: "text",
        });
        for (const handle of success.handles) {
          expect(handle.close).toHaveBeenCalledOnce();
          expect(handle.fd).toBe(-1);
        }
        vi.mocked(open).mockRejectedValueOnce(new Error("injected open failure"));
        expect(
          yield* Effect.result(files.readFile(1, { workspacePath: workspace, path: "file.txt" })),
        ).toMatchObject({
          _tag: "Failure",
          failure: { operation: "readFile", message: "injected open failure" },
        });
      }),
    ),
  );
});
