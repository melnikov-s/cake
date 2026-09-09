import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { WorktreeRecord } from "../../src/domain/managed-worktree-data";
import type { WorktreeStorageRepository } from "../../src/services/storage/WorktreeStorage";

export const makeTestWorktreeStorageRepository = (
  storagePath: string,
): WorktreeStorageRepository => ({
  async load() {
    try {
      const parsed: unknown = JSON.parse(await readFile(storagePath, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("records" in parsed) ||
        !Array.isArray(parsed.records)
      )
        return [];
      return parsed.records as ReadonlyArray<WorktreeRecord>;
    } catch {
      return [];
    }
  },
  async save(records) {
    const temporary = `${storagePath}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, records }, null, 2), "utf8");
      await rename(temporary, storagePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  },
});
