import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer } from "effect";
import { afterEach, describe, it } from "vitest";
import { defaultApplicationState } from "../../src/domain/application-data";
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
        resolvedCakeChatSessionIds: [],
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
    assert.equal(document.version, 1);
    assert.deepEqual(document.data, {
      ...defaultApplicationState(),
    });
    const fileInfo = await (await import("node:fs/promises")).stat(target);
    assert.equal(fileInfo.mode & 0o777, 0o600);
  });
});
