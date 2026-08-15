import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { CakePaths } from "./cake-paths";

export const piSessionMigrationVersion = 1;

export interface PiSessionMigrationDiagnostic {
  kind: "conflict" | "unsupported-entry";
  relativePath: string;
  message: string;
}

export interface PiSessionMigrationResult {
  status: "completed" | "already-completed";
  copiedFiles: number;
  diagnostics: PiSessionMigrationDiagnostic[];
  markerPath: string;
}

export interface PiSessionMigrationFileSystem {
  copyFile: typeof copyFile;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rename: typeof rename;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

const defaultFileSystem: PiSessionMigrationFileSystem = { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile };

function completedMarkerPath(paths: CakePaths) {
  return join(paths.migrations, `pi-sessions-v${piSessionMigrationVersion}.json`);
}

async function exists(path: string, fs: PiSessionMigrationFileSystem) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function digest(path: string, fs: PiSessionMigrationFileSystem) {
  return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}

async function hasSameContent(source: string, destination: string, fs: PiSessionMigrationFileSystem) {
  const [sourceStat, destinationStat] = await Promise.all([fs.lstat(source), fs.lstat(destination)]);
  return sourceStat.isFile()
    && destinationStat.isFile()
    && sourceStat.size === destinationStat.size
    && await digest(source, fs) === await digest(destination, fs);
}

/**
 * Copies standalone Pi sessions into Cake's isolated namespace exactly once.
 * The source is read-only, destination entries are never overwritten, and a
 * failed partial attempt remains safe to retry because copies are exclusive.
 */
export async function migrateLegacyPiSessions(
  paths: CakePaths,
  options: { fs?: Partial<PiSessionMigrationFileSystem>; onDiagnostic?(diagnostic: PiSessionMigrationDiagnostic): void } = {}
): Promise<PiSessionMigrationResult> {
  const fs: PiSessionMigrationFileSystem = { ...defaultFileSystem, ...options.fs };
  const markerPath = completedMarkerPath(paths);
  if (await exists(markerPath, fs)) {
    return { status: "already-completed", copiedFiles: 0, diagnostics: [], markerPath };
  }

  const diagnostics: PiSessionMigrationDiagnostic[] = [];
  let copiedFiles = 0;
  const record = (diagnostic: PiSessionMigrationDiagnostic) => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  const visit = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    await fs.mkdir(destinationDirectory, { recursive: true });
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const source = join(sourceDirectory, entry.name);
      const destination = join(destinationDirectory, entry.name);
      const relativePath = relative(paths.legacyPiSessions, source);

      if (entry.isDirectory()) {
        if (await exists(destination, fs) && !(await fs.lstat(destination)).isDirectory()) {
          record({ kind: "conflict", relativePath, message: `Kept Cake's existing session entry because legacy Pi has a directory at ${relativePath}` });
          continue;
        }
        await visit(source, destination);
        continue;
      }

      if (!entry.isFile()) {
        record({ kind: "unsupported-entry", relativePath, message: `Skipped non-file Pi session entry: ${relativePath}` });
        continue;
      }

      if (await exists(destination, fs)) {
        if (!await hasSameContent(source, destination, fs)) {
          record({ kind: "conflict", relativePath, message: `Kept Cake's existing session file because legacy Pi has different content at ${relativePath}` });
        }
        continue;
      }

      try {
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
        copiedFiles += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!await hasSameContent(source, destination, fs)) {
          record({ kind: "conflict", relativePath, message: `Kept Cake's existing session file because legacy Pi has different content at ${relativePath}` });
        }
      }
    }
  };

  if (await exists(paths.legacyPiSessions, fs)) await visit(paths.legacyPiSessions, paths.piSessions);
  else await fs.mkdir(paths.piSessions, { recursive: true });

  await fs.mkdir(dirname(markerPath), { recursive: true });
  const temporaryMarker = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  const marker = {
    version: piSessionMigrationVersion,
    completedAt: new Date().toISOString(),
    source: paths.legacyPiSessions,
    destination: paths.piSessions,
    copiedFiles,
    diagnostics
  };
  try {
    await fs.writeFile(temporaryMarker, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporaryMarker, markerPath);
  } catch (error) {
    await fs.unlink(temporaryMarker).catch(() => undefined);
    throw error;
  }

  return { status: "completed", copiedFiles, diagnostics, markerPath };
}
