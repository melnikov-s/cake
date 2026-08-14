import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

function markerPath(paths: CakePaths) {
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

async function sameContent(source: string, destination: string, fs: PiSessionMigrationFileSystem) {
  const [sourceStat, destinationStat] = await Promise.all([fs.lstat(source), fs.lstat(destination)]);
  return sourceStat.isFile()
    && destinationStat.isFile()
    && sourceStat.size === destinationStat.size
    && await digest(source, fs) === await digest(destination, fs);
}

/**
 * Copies the pre-isolation Pi session tree into Cake once. The source is always
 * read-only; partial copies are safe because files are created exclusively and
 * the completion marker is written only after the full traversal succeeds.
 */
export async function migrateLegacyPiSessions(
  paths: CakePaths,
  options: { fs?: Partial<PiSessionMigrationFileSystem>; onDiagnostic?(diagnostic: PiSessionMigrationDiagnostic): void } = {}
): Promise<PiSessionMigrationResult> {
  const fs: PiSessionMigrationFileSystem = { ...defaultFileSystem, ...options.fs };
  const completedMarker = markerPath(paths);
  if (await exists(completedMarker, fs)) {
    return { status: "already-completed", copiedFiles: 0, diagnostics: [], markerPath: completedMarker };
  }

  const diagnostics: PiSessionMigrationDiagnostic[] = [];
  let copiedFiles = 0;
  const record = (diagnostic: PiSessionMigrationDiagnostic) => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  const visit = async (sourceDirectory: string, destinationDirectory: string) => {
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
        if (!await sameContent(source, destination, fs)) {
          record({
            kind: "conflict",
            relativePath,
            message: `Kept Cake's existing session file because legacy Pi has different content at ${relativePath}`
          });
        }
        continue;
      }
      try {
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
        copiedFiles += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!await sameContent(source, destination, fs)) {
          record({
            kind: "conflict",
            relativePath,
            message: `Kept Cake's existing session file because legacy Pi has different content at ${relativePath}`
          });
        }
      }
    }
  };

  if (await exists(paths.legacyPiSessions, fs)) await visit(paths.legacyPiSessions, paths.piSessions);
  else await fs.mkdir(paths.piSessions, { recursive: true });

  await fs.mkdir(dirname(completedMarker), { recursive: true });
  const temporaryMarker = `${completedMarker}.${process.pid}.${crypto.randomUUID()}.tmp`;
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
    await fs.rename(temporaryMarker, completedMarker);
  } catch (error) {
    await fs.unlink(temporaryMarker).catch(() => undefined);
    throw error;
  }

  return { status: "completed", copiedFiles, diagnostics, markerPath: completedMarker };
}
