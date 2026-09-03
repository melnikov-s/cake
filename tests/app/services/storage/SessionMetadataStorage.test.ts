import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, it } from "vitest";
import {
  makeSessionMetadataStorageLive,
  SessionMetadataStorage,
} from "../../../../src/services/storage/SessionMetadataStorage";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SessionMetadataStorage", () => {
  it("stores and removes a title independently of transcript location", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-metadata-"));
    directories.push(root);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* SessionMetadataStorage;
        const first = yield* metadata.setTitle("session-1", "First title");
        const duplicate = yield* metadata.setTitle("session-1", "First title");
        const renamed = yield* metadata.setTitle("session-1", "Renamed title");
        const title = yield* metadata.title("session-1");
        yield* metadata.remove("session-1");
        const removed = yield* metadata.title("session-1");
        return { first, duplicate, renamed, title, removed };
      }).pipe(Effect.provide(makeSessionMetadataStorageLive(root))),
    );

    assert.deepEqual(result, {
      first: true,
      duplicate: false,
      renamed: true,
      title: "Renamed title",
      removed: undefined,
    });
  });
});
