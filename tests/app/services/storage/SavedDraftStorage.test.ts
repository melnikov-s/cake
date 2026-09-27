import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  SavedDraftStorage,
  makeSavedDraftStorageLive,
} from "../../../../src/services/storage/SavedDraftStorage";
import type { SavedDraft } from "../../../../src/domain/project-sessions/saved-draft-data";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const record: SavedDraft = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  projectPath: "/project",
  workingDirectory: "/project",
  title: "Task",
  text: "Do it",
  attachments: [],
  labelIds: [],
  resolved: false,
  createdAt: "2026-01-01T00:00:00Z",
  modifiedAt: "2026-01-01T00:00:00Z",
  revision: 1,
  status: "saved",
};
const withStorage = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "cake-saved-drafts-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const run = <A>(directory: string, effect: Effect.Effect<A, unknown, SavedDraftStorage>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(makeSavedDraftStorageLive(directory).pipe(Layer.provide(platform)))),
  );

describe("Saved Draft authority", () => {
  it("persists revisions through restart, rejects a stale client and admits one activation claim", async () => {
    await withStorage(async (directory) => {
      await run(
        directory,
        Effect.gen(function* () {
          yield* (yield* SavedDraftStorage).create(record);
        }),
      );
      const results = await run(
        directory,
        Effect.gen(function* () {
          const store = yield* SavedDraftStorage;
          const twoClients = yield* store.list();
          const updated = yield* store.update({ ...twoClients[0]!, text: "Second version" }, 1);
          const stale = yield* Effect.result(
            store.update({ ...twoClients[0]!, text: "Stale version" }, 1),
          );
          const claims = yield* Effect.all(
            [
              Effect.result(store.claim(record.sessionId, updated.revision, "/project")),
              Effect.result(store.claim(record.sessionId, updated.revision, "/project")),
            ],
            { concurrency: "unbounded" },
          );
          return { updated, stale, claims };
        }),
      );
      expect(results.updated.text).toBe("Second version");
      expect(results.stale._tag).toBe("Failure");
      expect(results.claims.filter((result) => result._tag === "Success")).toHaveLength(1);
      const [saved] = await run(
        directory,
        Effect.flatMap(SavedDraftStorage, (storage) => storage.list()),
      );
      expect(saved?.status).toBe("activating");
      expect(saved?.revision).toBe(3);
      const persisted = JSON.parse(await readFile(join(directory, "saved-drafts.json"), "utf8"));
      expect(persisted.records).toHaveLength(1);
    });
  });
});
