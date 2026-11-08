import type * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";
import {
  findSessionFilesByIds,
  findSessionFileById,
  findSessionFileMetadataById,
  streamSessionFiles,
} from "../../../../src/services/storage/session-files";
import { streamWorkspaceSessions } from "../../../../src/services/pi/runtime/session-discovery";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof fsPromises>();
  return { ...fs, stat: vi.fn(fs.stat), readdir: vi.fn(fs.readdir) };
});

const roots: string[] = [];
const timestamp = "2026-01-01T00-00-00-000Z";
const modifiedAt = new Date("2026-02-01T00:00:00.000Z");
const filename = (id: string) => `${timestamp}_${id}.jsonl`;
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-session-files-"));
  roots.push(root);
  return { workingDirectory: join(root, "project"), root, direct: true };
};
const collect = (input: Parameters<typeof streamSessionFiles>[0]) =>
  Effect.runPromise(streamSessionFiles(input).pipe(Stream.runCollect));
const statPaths = () => vi.mocked(stat).mock.calls.map(([path]) => String(path));

afterEach(async () => {
  vi.mocked(stat).mockReset();
  // Restore the real implementation, including after an injected stat failure.
  const fs = await vi.importActual<typeof fsPromises>("node:fs/promises");
  vi.mocked(stat).mockImplementation(fs.stat);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session metadata filename exclusions", () => {
  it("avoids excluded stats and preserves included metadata and enumeration order across batches", async () => {
    const input = await fixture();
    const ids = Array.from({ length: 100 }, (_, index) => `session-${index}`);
    await Promise.all(
      ids.map(async (id) => {
        const path = join(input.root, filename(id));
        await writeFile(path, "");
        await utimes(path, modifiedAt, modifiedAt);
      }),
    );
    vi.mocked(stat).mockClear();
    const all = await collect(input);
    expect(all).toHaveLength(100);
    expect(statPaths()).toHaveLength(100);
    const excludedSessionIds = ids.slice(0, 65);
    vi.mocked(stat).mockClear();
    const included = await collect({ ...input, excludedSessionIds });
    expect(included).toEqual(all.filter((item) => !excludedSessionIds.includes(item.id)));
    expect(included).toHaveLength(35);
    for (const item of included) {
      expect(item).toEqual({
        id: item.id,
        path: join(input.root, filename(item.id)),
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: modifiedAt.toISOString(),
      });
    }
    expect(statPaths().sort()).toEqual(included.map((item) => item.path).sort());
  });

  it("passes workspace exclusions down before stat and title reads", async () => {
    const input = await fixture();
    await writeFile(join(input.root, filename("excluded")), "unreadable transcript");
    vi.mocked(stat).mockClear();
    const sessions = await Effect.runPromise(
      streamWorkspaceSessions(input.workingDirectory, input.root, {
        direct: true,
        excludedSessionIds: ["excluded"],
      }).pipe(Stream.runCollect),
    );
    expect(sessions).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });

  it("excludes exact parsed IDs, not suffixes, and still stats malformed JSONL names", async () => {
    const input = await fixture();
    const names = [
      filename("excluded"),
      filename("not-excluded"),
      "malformed_excluded.jsonl",
      "2026-13-01T00-00-00-000Z_excluded.jsonl",
      "unrelated.txt",
    ];
    await Promise.all(names.map((name) => writeFile(join(input.root, name), "")));
    await mkdir(join(input.root, filename("directory")));
    vi.mocked(stat).mockClear();
    const metadata = await collect({ ...input, excludedSessionIds: ["excluded"] });
    expect(metadata.map((item) => item.id)).toEqual(["not-excluded"]);
    expect(statPaths().sort()).toEqual(
      names
        .slice(1, 4)
        .map((name) => join(input.root, name))
        .sort(),
    );
  });

  it.each([filename("included"), "malformed_excluded.jsonl"])(
    "preserves stat errors for %s even with exclusions",
    async (name) => {
      const input = await fixture();
      await writeFile(join(input.root, name), "");
      const error = Object.assign(new Error("stat failed"), { code: "EACCES" });
      vi.mocked(stat).mockRejectedValueOnce(error);
      await expect(collect({ ...input, excludedSessionIds: ["excluded"] })).rejects.toThrow(
        "stat failed",
      );
    },
  );

  it("keeps missing directories empty and propagates other directory errors", async () => {
    const input = await fixture();
    expect(await collect({ ...input, root: join(input.root, "missing") })).toEqual([]);
    const file = join(input.root, "not-directory");
    await writeFile(file, "");
    await expect(collect({ ...input, root: file })).rejects.toThrow("ENOTDIR");
  });
});

describe("exact session file lookups remain fresh", () => {
  it("batches selected IDs in one directory read without statting unrelated history", async () => {
    const input = await fixture();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        writeFile(join(input.root, filename(`session-${i}`)), ""),
      ),
    );
    vi.mocked(readdir).mockClear();
    vi.mocked(stat).mockClear();
    const files = await findSessionFilesByIds(
      new Set(["session-1", "session-20", "missing"]),
      input,
      new AbortController().signal,
    );
    expect([...files.keys()].sort()).toEqual(["session-1", "session-20"]);
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalled();
    await rm(join(input.root, filename("session-1")));
    const fresh = await findSessionFilesByIds(
      new Set(["session-1"]),
      input,
      new AbortController().signal,
    );
    expect(fresh.size).toBe(0);
  });

  it("observes a missing directory, new files, duplicates and deletions on successive calls", async () => {
    const input = await fixture();
    const directory = join(input.root, "sessions");
    const lookup = { ...input, root: directory };
    expect(await findSessionFileById("session", lookup)).toBeUndefined();
    await mkdir(directory);
    expect(await findSessionFileById("session", lookup)).toBeUndefined();
    const path = join(directory, filename("session"));
    await writeFile(path, "");
    await utimes(path, modifiedAt, modifiedAt);
    expect(await findSessionFileById("session", lookup)).toBe(path);
    expect(await findSessionFileMetadataById("session", lookup)).toEqual({
      id: "session",
      path,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: modifiedAt.toISOString(),
    });
    // Exact lookup historically matches suffixes even with a malformed timestamp.
    const duplicate = join(directory, "malformed_session.jsonl");
    await writeFile(duplicate, "");
    await expect(findSessionFileById("session", lookup)).rejects.toThrow(
      "Session ID collision detected: session",
    );
    await expect(findSessionFileMetadataById("session", lookup)).rejects.toThrow(
      "Session ID collision detected: session",
    );
    await rm(path);
    expect(await findSessionFileById("session", lookup)).toBe(duplicate);
    expect(await findSessionFileMetadataById("session", lookup)).toBeUndefined();
    await rm(duplicate);
    expect(await findSessionFileById("session", lookup)).toBeUndefined();
    expect(await findSessionFileMetadataById("session", lookup)).toBeUndefined();
  });

  it("does not confuse ID suffixes or directories with exact matches", async () => {
    const input = await fixture();
    await writeFile(join(input.root, filename("not-session")), "");
    await mkdir(join(input.root, filename("session")));
    expect(await findSessionFileById("session", input)).toBeUndefined();
    expect(await findSessionFileById("not-session", input)).toBe(
      join(input.root, filename("not-session")),
    );
  });

  it("propagates non-missing directory errors", async () => {
    const input = await fixture();
    const file = join(input.root, "not-directory");
    await writeFile(file, "");
    await expect(findSessionFileById("session", { ...input, root: file })).rejects.toThrow(
      "ENOTDIR",
    );
  });
});
