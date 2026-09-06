import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, it } from "vitest";
import { SESSION_TITLE_MAX_LENGTH } from "../../../../src/ipc/session-contract";
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

  it("caps persisted session titles", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-metadata-"));
    directories.push(root);
    const longTitle = "Long session title ".repeat(20);

    const title = await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* SessionMetadataStorage;
        yield* metadata.setTitle("session-1", longTitle);
        return yield* metadata.title("session-1");
      }).pipe(Effect.provide(makeSessionMetadataStorageLive(root))),
    );

    assert.equal(title, longTitle.trim().slice(0, SESSION_TITLE_MAX_LENGTH));
    assert.equal(title?.length, SESSION_TITLE_MAX_LENGTH);
  });
});
