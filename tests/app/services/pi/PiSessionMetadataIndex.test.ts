import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, it } from "vitest";
import {
  PiSessionMetadataIndex,
  PiSessionMetadataIndexLive,
} from "../../../../src/services/pi/PiSessionMetadataIndex";
import { sessionDirectoryPath } from "../../../../src/services/storage/session-files";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PiSessionMetadataIndex", () => {
  it("stores active session titles without touching transcript files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-pi-session-metadata-"));
    directories.push(root);
    const location = {
      workingDirectory: "/work/cake",
      sessionDirectory: join(root, "sessions"),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const index = yield* PiSessionMetadataIndex;
        const first = yield* index.setTitle(location, "session-1", "First title");
        const duplicate = yield* index.setTitle(location, "session-1", "First title");
        const renamed = yield* index.setTitle(location, "session-1", "Renamed title");
        const titles = yield* index.titles(location);
        return { first, duplicate, renamed, titles };
      }).pipe(Effect.provide(PiSessionMetadataIndexLive)),
    );

    assert.equal(result.first, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.renamed, true);
    assert.equal(result.titles.get("session-1"), "Renamed title");
    const directory = sessionDirectoryPath({
      workingDirectory: location.workingDirectory,
      root: location.sessionDirectory,
    });
    const document = JSON.parse(
      await readFile(join(directory, ".pi-session-metadata.json"), "utf8"),
    );
    assert.deepEqual(document, {
      version: 1,
      sessions: { "session-1": { title: "Renamed title" } },
    });
  });
});
