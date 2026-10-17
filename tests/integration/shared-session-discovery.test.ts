import { SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamSessionFileIds,
  streamSessionFiles,
  workingDirectorySessionPath,
} from "../../src/services/storage/session-files";

const roots: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";
const filename = (id: string) => `2026-01-01T00-00-00-000Z_${id}.jsonl`;
const collect = <A>(stream: Stream.Stream<A, unknown>) =>
  Effect.runPromise(Stream.runCollect(stream));

async function fixture() {
  const root = await fsp.mkdtemp(join(tmpdir(), "cake-session-discovery-"));
  roots.push(root);
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  const shared = join(root, "shared");
  await fsp.mkdir(agent);
  await fsp.mkdir(join(cwd, ".pi"), { recursive: true });
  await fsp.mkdir(shared);
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", shared);
  return {
    root,
    agent,
    cwd,
    shared,
    input: { workingDirectory: cwd, root: join(agent, "sessions") },
  };
}

async function session(directory: string, id: string, cwd: string) {
  const path = join(directory, filename(id));
  await fsp.writeFile(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp })}\n`,
  );
  return path;
}

// Update Node's named builtin exports too: the installed SDK is native ESM,
// not a Vitest-transformed mock. All spies call through to real fixture I/O.
function observeIO(directory: string) {
  const scans = vi.spyOn(fs, "readdirSync");
  const headers = vi.spyOn(fs, "openSync");
  const asyncScans = vi.spyOn(fsp, "readdir");
  const filenameScans = vi.spyOn(fsp, "opendir");
  const stats = vi.spyOn(fsp, "stat");
  const readStream = fs.createReadStream;
  let active = 0;
  let peak = 0;
  const bodies = vi.spyOn(fs, "createReadStream").mockImplementation((path, options) => {
    const stream = readStream(path, options);
    if (String(path).startsWith(`${directory}/`)) {
      active++;
      peak = Math.max(peak, active);
      stream.once("end", () => active--);
    }
    return stream;
  });
  const list = vi.spyOn(SessionManager, "list");
  const lookup = vi.spyOn(SessionManager, "findById");
  syncBuiltinESMExports();
  return {
    list,
    lookup,
    stats,
    counts: () => ({
      syncScans: scans.mock.calls.filter(([path]) => String(path) === directory).length,
      headerOpens: headers.mock.calls.filter(
        ([path]) => String(path).startsWith(`${directory}/`) && String(path).endsWith(".jsonl"),
      ).length,
      asyncScans: asyncScans.mock.calls.filter(([path]) => String(path) === directory).length,
      filenameScans: filenameScans.mock.calls.filter(([path]) => String(path) === directory).length,
      bodyStreams: bodies.mock.calls.filter(([path]) => String(path).startsWith(`${directory}/`))
        .length,
      peak,
    }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("shared-directory Pi discovery", () => {
  it("reproduces the old 40 lookups / 40 synchronous scans / 820 header opens", async () => {
    const f = await fixture();
    const ids = Array.from({ length: 40 }, (_, i) => `session-${String(i).padStart(2, "0")}`);
    await Promise.all(ids.map((id) => session(f.shared, id, f.cwd)));
    const io = observeIO(f.shared);
    for (const id of ids) expect(SessionManager.findById(f.cwd, id, f.shared)).toBeDefined();
    expect(io.lookup).toHaveBeenCalledTimes(40);
    expect(io.counts()).toEqual({
      syncScans: 40,
      headerOpens: 820,
      asyncScans: 0,
      filenameScans: 0,
      bodyStreams: 0,
      peak: 0,
    });
  });

  it.each(["ids", "metadata"] as const)(
    "40 shared sessions use one bounded SDK pass for %s",
    async (kind) => {
      const f = await fixture();
      const ids = Array.from({ length: 40 }, (_, i) => `session-${String(i).padStart(2, "0")}`);
      await Promise.all(ids.map((id) => session(f.shared, id, f.cwd)));
      const io = observeIO(f.shared);
      const result =
        kind === "ids"
          ? await collect(streamSessionFileIds(f.input))
          : (await collect(streamSessionFiles(f.input))).map((item) => item.id);
      expect(result.toSorted()).toEqual(ids);
      expect(io.list).toHaveBeenCalledTimes(1);
      expect(io.list).toHaveBeenCalledWith(f.cwd, f.shared, undefined, expect.any(AbortSignal));
      expect(io.lookup).not.toHaveBeenCalled();
      expect(io.counts()).toMatchObject({
        syncScans: 0,
        headerOpens: 0,
        asyncScans: 1,
        filenameScans: 1,
        bodyStreams: 40,
      });
      expect(io.counts().peak).toBeGreaterThan(0);
      expect(io.counts().peak).toBeLessThanOrEqual(10);
    },
  );

  it("filters workspaces and malformed/unrelated sessions exactly through SDK discovery", async () => {
    const f = await fixture();
    const own = await session(f.shared, "own", join(f.cwd, "nested", ".."));
    await session(f.shared, "other", join(f.root, "other"));
    await session(f.shared, "empty-cwd", "");
    await fsp.writeFile(join(f.shared, filename("corrupt")), "not json\n{}\n");
    await fsp.writeFile(
      join(f.shared, filename("non-session")),
      '{"type":"session_info","name":"unrelated"}\n',
    );
    await fsp.writeFile(
      join(f.shared, filename("missing-cwd")),
      JSON.stringify({ type: "session", version: 3, id: "missing-cwd", timestamp }),
    );
    const prefixed = await session(f.shared, "prefixed", f.cwd);
    await fsp.writeFile(
      prefixed,
      `invalid json\n${await fsp.readFile(prefixed, "utf8")}\ninvalid tail\n`,
    );
    await fsp.writeFile(join(f.shared, "notes.txt"), "not a transcript");
    await fsp.mkdir(join(f.shared, filename("directory")));
    const modified = new Date("2026-06-01T00:00:00.000Z");
    await fsp.utimes(own, modified, modified);
    const sdk = await SessionManager.list(f.cwd, f.shared);
    expect(sdk.map((item) => item.id).toSorted()).toEqual(["own", "prefixed"]);
    expect((await collect(streamSessionFileIds(f.input))).toSorted()).toEqual(
      sdk.map((item) => item.id).toSorted(),
    );
    const files = await collect(streamSessionFiles(f.input));
    expect(files.map((item) => item.id).toSorted()).toEqual(["own", "prefixed"]);
    expect(files.find((item) => item.id === "own")).toEqual({
      id: "own",
      path: own,
      createdAt: timestamp,
      modifiedAt: modified.toISOString(),
    });
    // A new enumeration observes SDK authority again, not a retained Cake index.
    await session(f.shared, "new", f.cwd);
    expect((await collect(streamSessionFileIds(f.input))).toSorted()).toEqual([
      "new",
      "own",
      "prefixed",
    ]);
  });

  it("keeps default, auxiliary and direct layouts cheap even with shared routing configured", async () => {
    const f = await fixture();
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    const normal = workingDirectorySessionPath(f.cwd, f.input.root);
    await fsp.mkdir(normal, { recursive: true });
    // Filename-only discovery must not open even a malformed transcript here.
    await fsp.writeFile(join(normal, filename("default")), "not json");
    const io = observeIO(normal);
    expect(await collect(streamSessionFileIds(f.input))).toEqual(["default"]);
    expect(io.stats).not.toHaveBeenCalled();
    expect((await collect(streamSessionFiles(f.input))).map((item) => item.id)).toEqual([
      "default",
    ]);
    expect(io.stats).toHaveBeenCalledTimes(1);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", f.shared);
    const auxiliaryInput = { workingDirectory: f.cwd, root: join(f.root, "auxiliary") };
    const auxiliary = workingDirectorySessionPath(f.cwd, auxiliaryInput.root);
    await fsp.mkdir(auxiliary, { recursive: true });
    await fsp.writeFile(join(auxiliary, filename("auxiliary")), "not json");
    expect(await collect(streamSessionFileIds(auxiliaryInput))).toEqual(["auxiliary"]);
    expect(await collect(streamSessionFileIds({ ...f.input, root: normal, direct: true }))).toEqual(
      ["default"],
    );
    expect(io.list).not.toHaveBeenCalled();
    expect(io.lookup).not.toHaveBeenCalled();
    expect(io.counts()).toEqual({
      syncScans: 0,
      headerOpens: 0,
      asyncScans: 0,
      filenameScans: 3,
      bodyStreams: 0,
      peak: 0,
    });
  });

  it("preserves separate global/project configured directories and environment precedence", async () => {
    const f = await fixture();
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    const otherCwd = join(f.root, "other-project");
    const otherShared = join(otherCwd, "project-sessions");
    await fsp.mkdir(join(otherCwd, ".pi"), { recursive: true });
    await fsp.mkdir(otherShared);
    await fsp.writeFile(join(f.agent, "settings.json"), JSON.stringify({ sessionDir: f.shared }));
    await fsp.writeFile(
      join(otherCwd, ".pi", "settings.json"),
      '{"sessionDir":"./project-sessions"}',
    );
    await session(f.shared, "global-own", f.cwd);
    await session(f.shared, "global-other", otherCwd);
    await session(otherShared, "project-own", otherCwd);
    await session(otherShared, "project-other", f.cwd);
    const otherInput = { ...f.input, workingDirectory: otherCwd };
    const io = observeIO(f.shared);
    expect(await collect(streamSessionFileIds(f.input))).toEqual(["global-own"]);
    expect((await collect(streamSessionFiles(otherInput))).map((item) => item.id)).toEqual([
      "project-own",
    ]);
    expect(io.list.mock.calls.map(([cwd, directory]) => [cwd, directory])).toEqual([
      [f.cwd, f.shared],
      [otherCwd, otherShared],
    ]);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", f.shared);
    expect(await collect(streamSessionFileIds(otherInput))).toEqual(["global-other"]);
    expect(io.list).toHaveBeenCalledTimes(3);
  });

  it("matches SDK empty results for a missing shared directory", async () => {
    const f = await fixture();
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(f.root, "missing"));
    expect(await collect(streamSessionFileIds(f.input))).toEqual([]);
    expect(await collect(streamSessionFiles(f.input))).toEqual([]);
  });
});
