import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer } from "effect";
import { afterEach, describe, it } from "vitest";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import {
  APPLICATION_DOCUMENT_NAME,
  ApplicationStorage,
  makeApplicationStorageLive,
} from "../../src/services/storage/ApplicationStorage";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ApplicationStorage filesystem integration", () => {
  it("migrates the legacy document and atomically persists the current envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-application-storage-"));
    directories.push(directory);
    const target = join(directory, APPLICATION_DOCUMENT_NAME);
    await writeFile(
      target,
      JSON.stringify({
        schemaVersion: 1,
        projects: [],
        resolvedSessionIds: ["session-1"],
        unreadSessionIds: [],
        trustedProjectPaths: [],
      }),
      "utf8",
    );

    const live = makeApplicationStorageLive(directory).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );
    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ApplicationStorage;
        return yield* storage.load();
      }).pipe(Effect.provide(live)),
    );

    assert.equal(loaded.source, "migrated");
    assert.ok(!("resolvedSessionIds" in loaded.state));
    const document = JSON.parse(await readFile(target, "utf8"));
    assert.equal(document.version, 6);
    // Migration retains the shipped v1 labels, rather than substituting today's
    // fresh-install defaults or adding optional preferences that were never saved.
    const migrated = {
      projects: [],
      globalSessionLabels: [
        { id: "00000000-0000-4000-8000-000000000001", name: "Feature", color: "blue" },
        { id: "00000000-0000-4000-8000-000000000002", name: "Bug", color: "rose" },
        { id: "00000000-0000-4000-8000-000000000003", name: "Research", color: "violet" },
        { id: "00000000-0000-4000-8000-000000000004", name: "Chore", color: "amber" },
      ],
      unreadSessionIds: [],
      trustedProjectPaths: [],
      fastModeSessionIds: [],
      modelPresets: [],
      cakePrompts: {},
      globalCustomInstructions: "",
      sessionPlugins: [],
      sessionPluginSharedState: [],
    };
    assert.deepEqual(loaded.state, migrated);
    assert.deepEqual(document.data, migrated);
    const fileInfo = await (await import("node:fs/promises")).stat(target);
    assert.equal(fileInfo.mode & 0o777, 0o600);
  });

  it("creates the state directory on the first save of a fresh installation", async () => {
    const home = await mkdtemp(join(tmpdir(), "cake-application-storage-fresh-"));
    directories.push(home);
    // Nothing has created `state/` yet, as on a machine Cake has never run on.
    const directory = join(home, "state");

    const live = makeApplicationStorageLive(directory).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ApplicationStorage;
        yield* storage.save(defaultApplicationState());
      }).pipe(Effect.provide(live)),
    );

    const document = JSON.parse(await readFile(join(directory, APPLICATION_DOCUMENT_NAME), "utf8"));
    assert.deepEqual(document.data, defaultApplicationState());
  });
});
