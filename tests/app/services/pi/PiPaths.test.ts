import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";
import { piProjectSessionDirectory } from "../../../../src/services/pi/PiPaths";
import {
  findSessionFileById,
  workingDirectorySessionPath,
} from "../../../../src/services/storage/session-files";
import { streamWorkspaceSessions } from "../../../../src/services/pi/runtime/session-discovery";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-shared-pi-paths-"));
  roots.push(root);
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agent);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
  return { root, agent, cwd, sessionsRoot: join(agent, "sessions") };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Shared Pi session routing", () => {
  it("honors environment over pre-trust project settings over global settings, without rewriting configuration", async () => {
    const f = await fixture();
    const global = join(f.agent, "settings.json");
    const project = join(f.cwd, ".pi", "settings.json");
    await writeFile(global, '{"sessionDir":"./global-sessions"}');
    expect(workingDirectorySessionPath(f.cwd, f.sessionsRoot)).toBe(join(f.cwd, "global-sessions"));
    await writeFile(
      project,
      '{"sessionDir":"./project-sessions","extensions":["/must-not-execute.ts"]}',
    );
    expect(workingDirectorySessionPath(f.cwd, f.sessionsRoot)).toBe(
      join(f.cwd, "project-sessions"),
    );
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "~/shared-pi-sessions");
    expect(piProjectSessionDirectory(f.cwd, f.sessionsRoot)).toEqual({
      directory: join(homedir(), "shared-pi-sessions"),
      shared: true,
    });
    expect(await readFile(global, "utf8")).toBe('{"sessionDir":"./global-sessions"}');
    expect(await readFile(project, "utf8")).toBe(
      '{"sessionDir":"./project-sessions","extensions":["/must-not-execute.ts"]}',
    );
    // Cake's auxiliary and old archive roots never follow project Pi overrides.
    expect(piProjectSessionDirectory(f.cwd, join(f.root, "archive")).shared).toBe(false);
  });

  it("filters custom shared directories by Pi's header cwd for lookup and active discovery", async () => {
    const f = await fixture();
    const custom = join(f.root, "all-project-sessions");
    await mkdir(custom);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", custom);
    for (const [id, cwd] of [
      ["own", f.cwd],
      ["other", join(f.root, "other-project")],
    ]) {
      await writeFile(
        join(custom, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
      );
    }
    expect(
      await findSessionFileById("own", { workingDirectory: f.cwd, root: f.sessionsRoot }),
    ).toContain("own.jsonl");
    expect(
      await findSessionFileById("other", { workingDirectory: f.cwd, root: f.sessionsRoot }),
    ).toBeUndefined();
    const sessions = await Effect.runPromise(
      Stream.runCollect(streamWorkspaceSessions(f.cwd, f.sessionsRoot)),
    );
    expect(sessions.map((session) => session.id)).toEqual(["own"]);
    const excluded = await Effect.runPromise(
      Stream.runCollect(
        streamWorkspaceSessions(f.cwd, f.sessionsRoot, { excludedSessionIds: ["own"] }),
      ),
    );
    expect(excluded).toEqual([]);
  });
});
