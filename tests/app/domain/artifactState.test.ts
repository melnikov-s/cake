import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactLineageId,
  ArtifactRevisionNumber,
} from "../../../src/contracts/artifacts/artifact-lineage";
import {
  ArtifactStateConflict,
  editArtifactState,
} from "../../../src/contracts/artifacts/artifact-state";
import type { CakeArtifactV1 } from "../../../src/contracts/artifacts/artifact-contract";
import * as state from "../../../src/domain/artifacts/artifactState";
import { createCakeArtifactOperations } from "../../../src/domain/artifacts/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import * as workflows from "../../../src/domain/artifacts/artifactWorkflows";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../../src/services/storage/ArtifactStorageLive";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const id = Schema.decodeUnknownSync(ArtifactLineageId)("editable");
const widget = (revision = 1): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id,
  sessionId: "owner",
  revision,
  kind: "widget",
  payload: {
    language: "html",
    source: "<p>Editable</p>",
    brief: "Editable",
    generationSessionId: "private",
  },
  fallback: { markdown: "Editable" },
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-state-"));
  directories.push(root);
  const events: CakeEvent[] = [];
  const layer = Layer.mergeAll(
    makeArtifactStorageLive(root).pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    ),
    Layer.mock(SessionFamilyStorage, {
      withMemberLock: (_id, effect) => effect,
      familyForMember: () => Effect.succeed(undefined),
    }),
    Layer.mock(ClientEvents, {
      sendTo: () => true,
      broadcast: (event) => {
        events.push(event);
      },
    }),
  );
  return { root, events, layer };
};
const create = workflows.create({
  sessionId: "owner",
  lineageId: id,
  snapshot: widget(),
  workingDirectory: "/project",
});

describe("artifact mutable state vertical domain/storage slice", () => {
  it("overwrites one current state, survives service restart and leaves immutable history untouched", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ArtifactStorage;
        const original = yield* create;
        expect(yield* state.read({ sessionId: "owner", lineageId: id })).toEqual({
          lineageId: id,
          version: 0,
          value: null,
        });
        yield* state.replace({
          sessionId: "owner",
          lineageId: id,
          expectedVersion: 0,
          value: { old: true },
        });
        yield* state.replace({
          sessionId: "owner",
          lineageId: id,
          expectedVersion: 1,
          value: { new: true },
        });
        expect(yield* storage.listRevisions(id)).toEqual([original]);
      }).pipe(Effect.provide(f.layer)),
    );
    // A fresh Layer/service reads only the latest value from disk.
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* state.read({ sessionId: "owner", lineageId: id })).toEqual({
          lineageId: id,
          version: 2,
          value: { new: true },
        });
      }).pipe(Effect.provide(f.layer)),
    );
    const envelope = JSON.parse(await readFile(join(f.root, "catalog.json"), "utf8"));
    expect(envelope.data.states).toEqual([{ lineageId: id, version: 2, value: { new: true } }]);
    expect(await readdir(join(f.root, "blobs"))).toHaveLength(1);
    expect(f.events.map((event) => event.type)).toEqual([
      "artifact-state-invalidated",
      "artifact-state-invalidated",
    ]);
  });

  it("scopes reads and writes to effective links, including pinned views", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* create;
        expect(
          (yield* Effect.flip(state.read({ sessionId: "stranger", lineageId: id })))._tag,
        ).toBe("ArtifactNotLinked");
        expect(
          (yield* Effect.flip(
            state.replace({
              sessionId: "stranger",
              lineageId: id,
              expectedVersion: 0,
              value: "bad",
            }),
          ))._tag,
        ).toBe("ArtifactNotLinked");
        yield* workflows.linkSession(id, "viewer", {
          mode: "pinned",
          revision: Schema.decodeUnknownSync(ArtifactRevisionNumber)(1),
        });
        yield* state.replace({
          sessionId: "owner",
          lineageId: id,
          expectedVersion: 0,
          value: "shared",
        });
        expect((yield* state.read({ sessionId: "viewer", lineageId: id })).value).toBe("shared");
        yield* workflows.unlinkSession(id, "viewer");
        expect((yield* Effect.flip(state.read({ sessionId: "viewer", lineageId: id })))._tag).toBe(
          "ArtifactNotLinked",
        );
      }).pipe(Effect.provide(f.layer)),
    );
  });

  it("allows exactly one concurrent version-CAS write without history", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* create;
        const results = yield* Effect.all(
          ["a", "b"].map((value) =>
            state
              .replace({ sessionId: "owner", lineageId: id, expectedVersion: 0, value })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
        expect((yield* state.read({ sessionId: "owner", lineageId: id })).version).toBe(1);
      }).pipe(Effect.provide(f.layer)),
    );
  });

  it("surgically updates JSON and rejects a partial or stale update without mutation", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* create;
        yield* state.replace({
          sessionId: "owner",
          lineageId: id,
          expectedVersion: 0,
          value: { "a/b": [1, 2], untouched: true },
        });
        const updated = yield* state.update({
          sessionId: "owner",
          lineageId: id,
          expectedVersion: 1,
          edits: [
            { op: "set", path: "/a~1b/0", value: 3 },
            { op: "remove", path: "/a~1b/1" },
            { op: "set", path: "/a~1b/-", value: 4 },
          ],
        });
        expect(updated.value).toEqual({ "a/b": [3, 4], untouched: true });
        expect(
          (yield* Effect.flip(
            state.update({
              sessionId: "owner",
              lineageId: id,
              expectedVersion: 2,
              edits: [
                { op: "set", path: "/untouched", value: false },
                { op: "remove", path: "/missing" },
              ],
            }),
          ))._tag,
        ).toBe("ArtifactStateError");
        expect(
          yield* Effect.flip(
            state.update({
              sessionId: "owner",
              lineageId: id,
              expectedVersion: 1,
              edits: [{ op: "set", path: "/untouched", value: false }],
            }),
          ),
        ).toBeInstanceOf(ArtifactStateConflict);
        expect(yield* state.read({ sessionId: "owner", lineageId: id })).toEqual(updated);
      }).pipe(Effect.provide(f.layer)),
    );
  });

  it("commits accepted source and changed candidate state together; stale acceptance publishes neither", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ArtifactStorage;
        yield* workflows.create({
          sessionId: "owner",
          lineageId: id,
          snapshot: widget(),
          workingDirectory: "/project",
          stagedState: { expectedVersion: 0, value: { scene: 1 } },
        });
        const rejected = yield* Effect.flip(
          workflows.publish({
            sessionId: "owner",
            lineageId: id,
            snapshot: widget(2),
            workingDirectory: "/project",
            expectedLatestRevision: 1,
            stagedState: { expectedVersion: 0, value: { scene: "obsolete" } },
          }),
        );
        expect(rejected).toBeInstanceOf(ArtifactStateConflict);
        expect(yield* storage.listRevisions(id)).toHaveLength(1);
        expect((yield* state.read({ sessionId: "owner", lineageId: id })).value).toEqual({
          scene: 1,
        });
        yield* workflows.publish({
          sessionId: "owner",
          lineageId: id,
          snapshot: widget(2),
          workingDirectory: "/project",
          expectedLatestRevision: 1,
          stagedState: { expectedVersion: 1, value: { scene: 2 } },
        });
        expect((yield* state.read({ sessionId: "owner", lineageId: id })).value).toEqual({
          scene: 2,
        });
        yield* state.replace({
          sessionId: "owner",
          lineageId: id,
          expectedVersion: 2,
          value: { scene: "live" },
        });
        // Source-only acceptance carries no state guard and preserves newer live edits.
        yield* workflows.publish({
          sessionId: "owner",
          lineageId: id,
          snapshot: widget(3),
          workingDirectory: "/project",
          expectedLatestRevision: 2,
        });
        expect((yield* state.read({ sessionId: "owner", lineageId: id })).value).toEqual({
          scene: "live",
        });
      }).pipe(Effect.provide(f.layer)),
    );
  });

  it("collects current state only when the lineage becomes unreachable", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ArtifactStorage;
        yield* create;
        yield* state.replace({
          sessionId: "owner",
          lineageId: id,
          expectedVersion: 0,
          value: { kept: true },
        });
        const { token } = yield* storage.collectionSnapshot();
        yield* storage.collectUnreachable({
          expectedCatalogToken: token,
          survivingSessionIds: [],
          survivingFamilyIds: [],
          transcriptLineageIds: [],
        });
      }).pipe(Effect.provide(f.layer)),
    );
    expect(JSON.parse(await readFile(join(f.root, "catalog.json"), "utf8")).data.states).toEqual(
      [],
    );
  });

  it("dispatches generic agent read/replace/update through validated Cake operations without artifact pointers", async () => {
    const f = await fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* create;
        const execute = Effect.runPromiseWith(
          yield* Effect.context<ArtifactStorage | SessionFamilyStorage | ClientEvents>(),
        );
        const pointers: unknown[] = [];
        const registry = new CakeOperationRegistry(
          createCakeArtifactOperations(
            {
              appendEntry: (...args) => {
                pointers.push(args);
              },
            },
            {
              persistArtifact: async () => {
                throw new Error("State writes cannot publish artifacts");
              },
              readArtifactState: (lineageId) =>
                execute(
                  state.read({
                    sessionId: "owner",
                    lineageId: Schema.decodeUnknownSync(ArtifactLineageId)(lineageId),
                  }),
                ),
              replaceArtifactState: (input) =>
                execute(state.replace({ ...input, sessionId: "owner" })),
              updateArtifactState: (input) =>
                execute(state.update({ ...input, sessionId: "owner" })),
            },
          ),
        );
        const context = {
          signal: new AbortController().signal,
          toolCallId: "state-tool",
          runtime: { sessionId: "owner", entryId: "entry" },
        };
        const read = yield* Effect.promise(() =>
          registry.invoke({ command: "artifacts.state.read", input: { lineageId: id } }, context),
        );
        expect(read.details).toMatchObject({ result: { lineageId: id, version: 0, value: null } });
        const saved = yield* Effect.promise(() =>
          registry.invoke(
            {
              command: "artifacts.state.replace",
              input: {
                lineageId: id,
                expectedVersion: 0,
                value: { title: "Original", kept: true },
              },
            },
            context,
          ),
        );
        expect(saved.details).toMatchObject({ result: { version: 1 } });
        const updated = yield* Effect.promise(() =>
          registry.invoke(
            {
              command: "artifacts.state.update",
              input: {
                lineageId: id,
                expectedVersion: 1,
                edits: [{ op: "set", path: "/title", value: "Agent edit" }],
              },
            },
            context,
          ),
        );
        expect(updated.details).toMatchObject({
          result: { version: 2, value: { title: "Agent edit", kept: true } },
        });
        const invalid = yield* Effect.tryPromise({
          try: () =>
            registry.invoke(
              {
                command: "artifacts.state.replace",
                input: { lineageId: id, expectedVersion: -1, value: null },
              },
              context,
            ),
          catch: (error) => error,
        }).pipe(Effect.flip);
        expect(String(invalid)).toContain("expectedVersion");
        expect(pointers).toEqual([]);
        expect(yield* (yield* ArtifactStorage).listRevisions(id)).toHaveLength(1);
      }).pipe(Effect.provide(f.layer)),
    );
  });

  it("does not traverse inherited JSON-pointer properties or mutate prototypes", () => {
    expect(() =>
      editArtifactState({}, [{ op: "set", path: "/__proto__/polluted", value: true }]),
    ).toThrow();
    expect(
      editArtifactState({}, [{ op: "set", path: "/__proto__", value: { safe: true } }]),
    ).toEqual(JSON.parse('{"__proto__":{"safe":true}}'));
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
