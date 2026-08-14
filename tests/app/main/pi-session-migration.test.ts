import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCakePaths } from "../../../src/main/cake-paths";
import { migrateLegacyPiSessions, piSessionMigrationVersion } from "../../../src/main/pi-session-migration";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-session-migration-"));
  roots.push(root);
  const homeDirectory = join(root, "home");
  const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory });
  return { root, paths };
}

describe("migrateLegacyPiSessions", () => {
  it("recursively copies the first-run tree and records completion", async () => {
    const { paths } = await fixture();
    await mkdir(join(paths.legacyPiSessions, "workspace", "nested"), { recursive: true });
    await writeFile(join(paths.legacyPiSessions, "workspace", "one.jsonl"), "one\n");
    await writeFile(join(paths.legacyPiSessions, "workspace", "nested", "two.jsonl"), "two\n");

    const result = await migrateLegacyPiSessions(paths);

    expect(result).toMatchObject({ status: "completed", copiedFiles: 2, diagnostics: [] });
    expect(await readFile(join(paths.piSessions, "workspace", "one.jsonl"), "utf8")).toBe("one\n");
    expect(await readFile(join(paths.piSessions, "workspace", "nested", "two.jsonl"), "utf8")).toBe("two\n");
    expect(JSON.parse(await readFile(result.markerPath, "utf8"))).toMatchObject({ version: piSessionMigrationVersion, copiedFiles: 2 });
  });

  it("treats a missing source as a successful no-op", async () => {
    const { paths } = await fixture();
    const result = await migrateLegacyPiSessions(paths);
    expect(result).toMatchObject({ status: "completed", copiedFiles: 0, diagnostics: [] });
    expect((await lstat(paths.piSessions)).isDirectory()).toBe(true);
    expect((await lstat(result.markerPath)).isFile()).toBe(true);
  });

  it("does not rescan after the versioned marker exists", async () => {
    const { paths } = await fixture();
    await mkdir(paths.legacyPiSessions, { recursive: true });
    await writeFile(join(paths.legacyPiSessions, "first.jsonl"), "first\n");
    await migrateLegacyPiSessions(paths);
    await writeFile(join(paths.legacyPiSessions, "later.jsonl"), "later\n");

    const result = await migrateLegacyPiSessions(paths);
    expect(result.status).toBe("already-completed");
    await expect(readFile(join(paths.piSessions, "later.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges missing files into a partial destination", async () => {
    const { paths } = await fixture();
    await Promise.all([mkdir(paths.legacyPiSessions, { recursive: true }), mkdir(paths.piSessions, { recursive: true })]);
    await writeFile(join(paths.legacyPiSessions, "existing.jsonl"), "same\n");
    await writeFile(join(paths.legacyPiSessions, "missing.jsonl"), "new\n");
    await writeFile(join(paths.piSessions, "existing.jsonl"), "same\n");

    const result = await migrateLegacyPiSessions(paths);
    expect(result).toMatchObject({ copiedFiles: 1, diagnostics: [] });
    expect(await readFile(join(paths.piSessions, "missing.jsonl"), "utf8")).toBe("new\n");
  });

  it("keeps conflicting destination content and records an actionable diagnostic", async () => {
    const { paths } = await fixture();
    await Promise.all([mkdir(paths.legacyPiSessions, { recursive: true }), mkdir(paths.piSessions, { recursive: true })]);
    await writeFile(join(paths.legacyPiSessions, "conflict.jsonl"), "legacy\n");
    await writeFile(join(paths.piSessions, "conflict.jsonl"), "cake\n");
    const onDiagnostic = vi.fn();

    const result = await migrateLegacyPiSessions(paths, { onDiagnostic });

    expect(await readFile(join(paths.piSessions, "conflict.jsonl"), "utf8")).toBe("cake\n");
    expect(result.diagnostics).toEqual([expect.objectContaining({ kind: "conflict", relativePath: "conflict.jsonl", message: expect.stringContaining("Kept Cake's existing") })]);
    expect(onDiagnostic).toHaveBeenCalledWith(result.diagnostics[0]);
    expect(JSON.parse(await readFile(result.markerPath, "utf8")).diagnostics).toEqual(result.diagnostics);
  });

  it("leaves the marker absent after partial failure and safely retries", async () => {
    const { paths } = await fixture();
    await mkdir(paths.legacyPiSessions, { recursive: true });
    await writeFile(join(paths.legacyPiSessions, "one.jsonl"), "one\n");
    await writeFile(join(paths.legacyPiSessions, "two.jsonl"), "two\n");
    let attempts = 0;

    await expect(migrateLegacyPiSessions(paths, {
      fs: {
        async copyFile(source, destination, mode) {
          attempts += 1;
          if (attempts === 2) throw Object.assign(new Error("simulated copy failure"), { code: "EIO" });
          await copyFile(source, destination, mode);
        }
      }
    })).rejects.toThrow("simulated copy failure");
    await expect(readdir(paths.migrations)).rejects.toMatchObject({ code: "ENOENT" });

    const retried = await migrateLegacyPiSessions(paths);
    expect(retried).toMatchObject({ status: "completed", copiedFiles: 1 });
    expect(await readFile(join(paths.piSessions, "one.jsonl"), "utf8")).toBe("one\n");
    expect(await readFile(join(paths.piSessions, "two.jsonl"), "utf8")).toBe("two\n");
  });
});
