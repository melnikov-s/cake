import type * as fsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findSessionFileById,
  findSessionFileMetadataById,
  hasSessionFileById,
  snapshotSessionFiles,
  workingDirectorySessionPath,
} from "../../../../src/services/storage/session-files";
import { loadWorkspacePiSessionSummary } from "../../../../src/services/pi/runtime/session-discovery";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof fsPromises>();
  return { ...fs, lstat: vi.fn(fs.lstat), readdir: vi.fn(fs.readdir) };
});

const roots: string[] = [];
const timestamp = "2026-01-01T00-00-00-000Z";
const filename = (id: string) => `${timestamp}_${id}.jsonl`;
const signal = () => new AbortController().signal;
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-session-snapshot-"));
  roots.push(root);
  return { workingDirectory: join(root, "project"), root, direct: true };
};
const header = (id: string, cwd: string) =>
  `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" })}\n`;

afterEach(async () => {
  vi.restoreAllMocks();
  const fs = await vi.importActual<typeof fsPromises>("node:fs/promises");
  vi.mocked(readdir).mockReset().mockImplementation(fs.readdir);
  vi.mocked(lstat).mockReset().mockImplementation(fs.lstat);
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generation-local session filename snapshots", () => {
  it("shares one listing across concurrent metadata and summary lookups, without caching bodies or stats", async () => {
    const input = await fixture();
    const ids = Array.from({ length: 50 }, (_, i) => `session-${i}`);
    await Promise.all(
      ids.map((id) =>
        writeFile(join(input.root, filename(id)), header(id, input.workingDirectory)),
      ),
    );
    const snapshot = await snapshotSessionFiles(input, signal());
    expect(Object.isFrozen(snapshot)).toBe(true);
    vi.mocked(readdir).mockClear();
    vi.mocked(lstat).mockClear();
    const items = await Promise.all(
      ids.map((id) => findSessionFileMetadataById(id, { ...input, fileSnapshot: snapshot })),
    );
    expect(items.map((item) => item?.id)).toEqual(ids);
    const summary = await loadWorkspacePiSessionSummary(
      input.workingDirectory,
      "session-0",
      input.root,
      { direct: true, fileSnapshot: snapshot },
    );
    expect(summary?.sessionFile).toBe(items[0]?.path);
    expect(readdir).not.toHaveBeenCalled();
    expect(lstat).toHaveBeenCalledTimes(51);
  });

  it("observes external create/delete/rename and collisions in the next generation even when directory mtime is restored", async () => {
    const input = await fixture();
    const original = join(input.root, filename("one"));
    await writeFile(original, "original");
    const directoryTime = (await lstat(input.root)).mtime;
    const first = await snapshotSessionFiles(input, signal());
    await rename(original, join(input.root, filename("two")));
    await writeFile(join(input.root, filename("three")), "external Pi write");
    await utimes(input.root, directoryTime, directoryTime);
    expect(first.find("three")).toBeUndefined(); // Membership is explicitly listing-time evidence.
    await expect(
      findSessionFileMetadataById("one", { ...input, fileSnapshot: first }),
    ).rejects.toThrow("ENOENT");
    const next = await snapshotSessionFiles(input, signal());
    expect(next.find("one")).toBeUndefined();
    expect(next.find("two")).toBe(join(input.root, filename("two")));
    expect(next.find("three")).toBe(join(input.root, filename("three")));
    await writeFile(join(input.root, "malformed_two.jsonl"), "collision");
    const collision = await snapshotSessionFiles(input, signal());
    expect(() => collision.find("two")).toThrow("Session ID collision detected: two");
    await rm(join(input.root, "malformed_two.jsonl"));
    expect((await snapshotSessionFiles(input, signal())).find("two")).toBeDefined();
  });

  it("reads fresh metadata after atomic replacement and in-place external writes", async () => {
    const input = await fixture();
    const path = join(input.root, filename("one"));
    await writeFile(path, "old");
    const snapshot = await snapshotSessionFiles(input, signal());
    const replacement = join(input.root, "replacement");
    const modified = new Date("2026-03-01T00:00:00.000Z");
    await writeFile(replacement, "replacement contents never retained");
    await utimes(replacement, modified, modified);
    await rename(replacement, path);
    expect(
      (await findSessionFileMetadataById("one", { ...input, fileSnapshot: snapshot }))?.modifiedAt,
    ).toBe(modified.toISOString());
    await writeFile(path, "external append");
    const later = new Date("2026-04-01T00:00:00.000Z");
    await utimes(path, later, later);
    expect(
      (await findSessionFileMetadataById("one", { ...input, fileSnapshot: snapshot }))?.modifiedAt,
    ).toBe(later.toISOString());
  });

  it("does not carry active/resolved namespace membership across file moves", async () => {
    const input = await fixture();
    const active = { ...input, root: join(input.root, "active") };
    const resolved = { ...input, root: join(input.root, "resolved") };
    await mkdir(active.root);
    await mkdir(resolved.root);
    const path = join(active.root, filename("one"));
    const archived = join(resolved.root, filename("one"));
    await writeFile(path, "history");
    const snapshot = await snapshotSessionFiles(active, signal());
    await rename(path, archived);
    await expect(
      findSessionFileMetadataById("one", { ...active, fileSnapshot: snapshot }),
    ).rejects.toThrow("ENOENT");
    expect(await findSessionFileById("one", active)).toBeUndefined();
    expect(await findSessionFileById("one", resolved)).toBe(archived);
    expect((await snapshotSessionFiles(resolved, signal())).find("one")).toBe(archived);
    await expect(
      findSessionFileMetadataById("one", { ...resolved, fileSnapshot: snapshot }),
    ).rejects.toThrow("routing mismatch");
    await rename(archived, path);
    expect((await snapshotSessionFiles(resolved, signal())).find("one")).toBeUndefined();
    expect(await hasSessionFileById("one", active)).toBe(true);
  });

  it("handles missing directories afresh and preserves permission/namespace errors", async () => {
    const input = await fixture();
    const missing = { ...input, root: join(input.root, "missing") };
    expect((await snapshotSessionFiles(missing, signal())).find("one")).toBeUndefined();
    await mkdir(missing.root);
    await writeFile(join(missing.root, filename("one")), "new");
    expect((await snapshotSessionFiles(missing, signal())).find("one")).toBeDefined();
    const notDirectory = join(input.root, "file");
    await writeFile(notDirectory, "");
    await expect(snapshotSessionFiles({ ...input, root: notDirectory }, signal())).rejects.toThrow(
      "ENOTDIR",
    );
    const denied = Object.assign(new Error("EACCES fixture"), { code: "EACCES" });
    vi.mocked(readdir).mockRejectedValueOnce(denied);
    await expect(snapshotSessionFiles(input, signal())).rejects.toBe(denied);
    const snapshot = await snapshotSessionFiles(missing, signal());
    vi.mocked(lstat).mockRejectedValueOnce(denied);
    await expect(
      findSessionFileMetadataById("one", { ...missing, fileSnapshot: snapshot }),
    ).rejects.toBe(denied);
  });

  it("excludes non-files and symlinks and refuses a symlink or directory replacing a listed file", async () => {
    const input = await fixture();
    const path = join(input.root, filename("one"));
    await writeFile(path, "");
    await mkdir(join(input.root, filename("directory")));
    await symlink(path, join(input.root, filename("link")));
    const snapshot = await snapshotSessionFiles(input, signal());
    expect(snapshot.find("directory")).toBeUndefined();
    expect(snapshot.find("link")).toBeUndefined();
    // Empty files are still catalog metadata, not recovery authority.
    expect(
      await findSessionFileMetadataById("one", { ...input, fileSnapshot: snapshot }),
    ).toBeDefined();
    await expect(hasSessionFileById("one", input)).rejects.toThrow("nonempty regular file");
    await rm(path);
    await symlink(join(input.root, "outside"), path);
    await expect(
      findSessionFileMetadataById("one", { ...input, fileSnapshot: snapshot }),
    ).rejects.toThrow("requires a regular file");
    await rm(path);
    await mkdir(path);
    await expect(
      findSessionFileMetadataById("one", { ...input, fileSnapshot: snapshot }),
    ).rejects.toThrow("requires a regular file");
  });

  it("retains suffix semantics for underscored IDs, malformed and empty histories, and real collisions", async () => {
    const input = await fixture();
    await writeFile(join(input.root, filename("a_b")), "");
    await writeFile(join(input.root, "bad_legacy.jsonl"), "");
    const snapshot = await snapshotSessionFiles(input, signal());
    expect(snapshot.find("a_b")).toBe(join(input.root, filename("a_b")));
    expect(snapshot.find("b")).toBe(join(input.root, filename("a_b")));
    expect(snapshot.find("legacy")).toBe(join(input.root, "bad_legacy.jsonl"));
    expect(
      await findSessionFileMetadataById("legacy", { ...input, fileSnapshot: snapshot }),
    ).toBeUndefined();
    await writeFile(join(input.root, "another_a_b.jsonl"), "");
    const collision = await snapshotSessionFiles(input, signal());
    for (const id of ["a_b", "b"])
      expect(() => collision.find(id)).toThrow(`Session ID collision detected: ${id}`);
  });

  it("isolates project/root routing and refuses snapshots for another cwd", async () => {
    const input = await fixture();
    const routed = { ...input, direct: false };
    const directory = workingDirectorySessionPath(input.workingDirectory, input.root);
    await mkdir(directory);
    await writeFile(join(directory, filename("one")), "history");
    const snapshot = await snapshotSessionFiles(routed, signal());
    expect(snapshot.find("one")).toBe(join(directory, filename("one")));
    expect((await snapshotSessionFiles(input, signal())).find("one")).toBeUndefined();
    await expect(
      findSessionFileMetadataById("one", { ...input, fileSnapshot: snapshot }),
    ).rejects.toThrow("routing mismatch");
    await expect(
      findSessionFileMetadataById("one", {
        ...routed,
        workingDirectory: join(input.root, "other"),
        fileSnapshot: snapshot,
      }),
    ).rejects.toThrow("routing mismatch");
  });

  it("filters a shared root with one SDK pass, preserves collisions before cwd filtering, and refreshes external header writes next generation", async () => {
    const input = await fixture();
    const agent = join(input.root, "agent");
    const directory = join(input.root, "shared");
    await mkdir(agent);
    await mkdir(input.workingDirectory);
    await mkdir(directory);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", directory);
    const shared = { ...input, root: join(agent, "sessions"), direct: false };
    const other = join(input.root, "other");
    await writeFile(join(directory, filename("one")), header("one", input.workingDirectory));
    await writeFile(join(directory, filename("two")), header("two", other));
    const list = vi.spyOn(SessionManager, "list");
    const snapshot = await snapshotSessionFiles(shared, signal());
    expect(snapshot.find("one")).toBeDefined();
    expect(snapshot.find("two")).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
    await writeFile(join(directory, filename("two")), header("two", input.workingDirectory));
    expect((await snapshotSessionFiles(shared, signal())).find("two")).toBeDefined();
    await writeFile(join(directory, "bad_two.jsonl"), header("two", other));
    expect(() => snapshot.find("two")).not.toThrow();
    const collision = await snapshotSessionFiles(shared, signal());
    expect(() => collision.find("two")).toThrow("Session ID collision detected: two");
  });

  it("honors cancellation before/during listing and revokes cancelled generation evidence without retained handles", async () => {
    const input = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(snapshotSessionFiles(input, controller.signal)).rejects.toThrow();
    expect(readdir).not.toHaveBeenCalled();
    let release: () => void = () => {
      throw new Error("listing not started");
    };
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fs = await vi.importActual<typeof fsPromises>("node:fs/promises");
    vi.mocked(readdir).mockImplementationOnce(async (...args: Parameters<typeof fs.readdir>) => {
      await pending;
      return fs.readdir(...args);
    });
    const during = new AbortController();
    const acquisition = snapshotSessionFiles(input, during.signal);
    during.abort();
    release();
    await expect(acquisition).rejects.toThrow();
    const lifetime = new AbortController();
    const snapshot = await snapshotSessionFiles(input, lifetime.signal);
    lifetime.abort();
    expect(() => snapshot.find("missing")).toThrow();
    expect((await snapshotSessionFiles(input, signal())).find("missing")).toBeUndefined();
  });

  it("measures exact versus generation-local metadata discovery on 2500 files / 250 IDs", async () => {
    const input = await fixture();
    const ids = Array.from({ length: 2500 }, (_, i) => `session-${i}`);
    // Bound fixture creation I/O rather than launching thousands of pending writes.
    for (let start = 0; start < ids.length; start += 50)
      await Promise.all(
        ids
          .slice(start, start + 50)
          .map((id) => writeFile(join(input.root, filename(id)), "fixture")),
      );
    const selected = ids.slice(0, 250);
    const measure = async (run: () => Promise<unknown>) => {
      vi.mocked(readdir).mockClear();
      const cpu = process.cpuUsage();
      const start = performance.now();
      await run();
      const elapsedMs = performance.now() - start;
      const usage = process.cpuUsage(cpu);
      return {
        readdir: vi.mocked(readdir).mock.calls.length,
        elapsedMs,
        cpuMs: (usage.user + usage.system) / 1000,
      };
    };
    const before = await measure(async () => {
      for (const id of selected) expect(await findSessionFileMetadataById(id, input)).toBeDefined();
    });
    const after = await measure(async () => {
      const snapshot = await snapshotSessionFiles(input, signal());
      for (const id of selected)
        expect(
          await findSessionFileMetadataById(id, { ...input, fileSnapshot: snapshot }),
        ).toBeDefined();
    });
    expect(before.readdir).toBe(250);
    expect(after.readdir).toBe(1);
    console.info("session filename discovery fixture (warm OS caches, not app startup)", {
      files: ids.length,
      selected: selected.length,
      before,
      after,
    });
  }, 30_000);
});
