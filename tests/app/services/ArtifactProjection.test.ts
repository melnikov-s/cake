import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactDigest,
  ArtifactLineageId,
  ArtifactRevisionNumber,
  type ArtifactRevision,
} from "../../../src/domain/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../../src/ipc/artifact-contract";
import { ArtifactProjection } from "../../../src/services/artifacts/ArtifactProjection";
import {
  artifactProjectionContents,
  makeArtifactProjectionLive,
} from "../../../src/services/artifacts/ArtifactProjectionLive";

const roots: string[] = [];
const unlock = async (target: string): Promise<void> => {
  const info = await stat(target).catch(() => undefined);
  if (!info?.isDirectory()) return;
  await chmod(target, 0o755);
  await Promise.all((await readdir(target)).map((name) => unlock(join(target, name))));
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await unlock(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});
const revisionNumber = (value: number) => Schema.decodeUnknownSync(ArtifactRevisionNumber)(value);
const revision = (snapshot: CakeArtifactV1, digestCharacter = "a"): ArtifactRevision => ({
  lineageId: Schema.decodeUnknownSync(ArtifactLineageId)(snapshot.id),
  metadata: {
    revision: revisionNumber(snapshot.revision),
    digest: Schema.decodeUnknownSync(ArtifactDigest)(digestCharacter.repeat(64)),
    kind: snapshot.kind,
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedBySessionId: snapshot.sessionId,
    workingDirectory: "/workspace",
  },
  snapshot,
});
const markdown = (number: number, value: string): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id: "plan",
  sessionId: "session-1",
  revision: number,
  kind: "markdown",
  payload: { markdown: value },
  fallback: { markdown: value },
  interaction: { mode: "present" },
});

const makeLayer = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-projection-"));
  roots.push(root);
  return makeArtifactProjectionLive(join(root, "cache")).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );
};

describe("ArtifactProjection", () => {
  it("uses deterministic exact/latest paths and preserves exact revisions after updates", async () => {
    const layer = await makeLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ArtifactProjection;
        const first = yield* service.materialize({
          sessionId: "session-1",
          revision: revision(markdown(1, "one")),
          latestRevision: revisionNumber(1),
          linkMode: "follow-latest",
        });
        const second = yield* service.materialize({
          sessionId: "session-1",
          revision: revision(markdown(2, "two"), "b"),
          latestRevision: revisionNumber(2),
          linkMode: "follow-latest",
        });
        expect(first.exactPath).toContain("/sessions/session-1/plan/revisions/r00000001");
        expect(second.latestPath).toBe(second.exactPath);
        const firstContent = yield* Effect.promise(() =>
          readFile(join(first.exactPath, "content.md"), "utf8"),
        );
        const secondContent = yield* Effect.promise(() =>
          readFile(join(second.exactPath, "content.md"), "utf8"),
        );
        expect(firstContent).toBe("one");
        expect(secondContent).toBe("two");
      }).pipe(Effect.provide(layer)),
    );
  });

  it("detects and rematerializes modified disposable cache files without mutating storage values", async () => {
    const layer = await makeLayer();
    const source = markdown(1, "authoritative");
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ArtifactProjection;
        const projected = yield* service.materialize({
          sessionId: "session-1",
          revision: revision(source),
          latestRevision: revisionNumber(1),
          linkMode: "follow-latest",
        });
        const target = join(projected.exactPath, "content.md");
        yield* Effect.promise(() => chmod(projected.exactPath, 0o755));
        yield* Effect.promise(() => chmod(target, 0o644));
        yield* Effect.promise(() => writeFile(target, "tampered"));
        const repaired = yield* service.materialize({
          sessionId: "session-1",
          revision: revision(source),
          latestRevision: revisionNumber(1),
          linkMode: "follow-latest",
        });
        const repairedContent = yield* Effect.promise(() =>
          readFile(join(repaired.exactPath, "content.md"), "utf8"),
        );
        expect(repairedContent).toBe("authoritative");
        expect(source.kind === "markdown" && source.payload.markdown).toBe("authoritative");
      }).pipe(Effect.provide(layer)),
    );
  });

  it("cleans only disposable session/lineage projections", async () => {
    const layer = await makeLayer();
    const target = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ArtifactProjection;
        const projected = yield* service.materialize({
          sessionId: "session-1",
          revision: revision(markdown(1, "authoritative")),
          latestRevision: revisionNumber(1),
          linkMode: "follow-latest",
        });
        yield* service.cleanupLineage(
          "session-1",
          Schema.decodeUnknownSync(ArtifactLineageId)(projected.lineageId),
        );
        return join(projected.exactPath, "content.md");
      }).pipe(Effect.provide(layer)),
    );
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("rejects traversal segments", async () => {
    const layer = await makeLayer();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ArtifactProjection;
        return yield* service
          .materialize({
            sessionId: "../outside",
            revision: revision(markdown(1, "one")),
            latestRevision: revisionNumber(1),
            linkMode: "follow-latest",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    );
    expect(failure.message).toContain("Unsafe session ID");
  });

  it("reconciles stale session and lineage caches without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifact-projection-cleanup-"));
    roots.push(root);
    const cacheRoot = join(root, "cache");
    const layer = makeArtifactProjectionLive(cacheRoot).pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );
    const external = join(root, "external");
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "sentinel"), "keep");

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ArtifactProjection;
        yield* service.materialize({
          sessionId: "surviving",
          revision: revision(markdown(1, "keep")),
          latestRevision: revisionNumber(1),
          linkMode: "follow-latest",
        });
        yield* service.materialize({
          sessionId: "deleted",
          revision: revision(markdown(1, "drop")),
          latestRevision: revisionNumber(1),
          linkMode: "follow-latest",
        });
        const sessionsRoot = join(cacheRoot, "artifact-projections", "v1", "sessions");
        yield* Effect.promise(() => symlink(external, join(sessionsRoot, "escaped")));
        const stats = yield* service.cleanup({
          retained: [
            { sessionId: "surviving", lineageIds: [] },
            { sessionId: "escaped", lineageIds: [] },
          ],
        });
        expect(stats).toEqual({ sessionsRemoved: 2, lineagesRemoved: 1 });
      }).pipe(Effect.provide(layer)),
    );
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep");
    await expect(
      stat(join(cacheRoot, "artifact-projections", "v1", "sessions", "escaped")),
    ).rejects.toThrow();
  });

  it("emits canonical files for every stored kind and excludes private widget source", () => {
    const base = {
      protocol: "cake.artifact/v1" as const,
      id: "artifact",
      sessionId: "session-1",
      revision: 1,
      fallback: { markdown: "fallback" },
      interaction: { mode: "present" as const },
    };
    const snapshots: CakeArtifactV1[] = [
      { ...base, kind: "markdown", payload: { markdown: "# doc" } },
      {
        ...base,
        kind: "table",
        payload: { columns: [{ id: "name", label: "Name" }], rows: [{ id: "one", name: "A" }] },
      },
      { ...base, kind: "form", payload: { fields: [{ id: "name", label: "Name", type: "text" }] } },
      { ...base, kind: "diff", payload: { diff: "--- a\n+++ b" } },
      { ...base, kind: "diagram", payload: { source: "flowchart LR\nA-->B" } },
      { ...base, kind: "html", payload: { html: "<script>secret()</script>" } },
      {
        ...base,
        kind: "file",
        payload: { name: "report.txt", mimeType: "text/plain", data: "aGk=", byteSize: 2 },
      },
      {
        ...base,
        kind: "media",
        payload: { mediaType: "image", src: "data:image/png;base64,aGk=" },
      },
      {
        ...base,
        kind: "widget",
        payload: {
          language: "react",
          source: "PRIVATE GENERATED SOURCE",
          brief: "Public brief",
          generationSessionId: "generation-1",
        },
      },
    ];
    const names = snapshots.map((snapshot) =>
      artifactProjectionContents(snapshot).map((item) => item.name),
    );
    expect(names).toEqual([
      ["content.md", "fallback.md"],
      ["table.json", "table.csv", "fallback.md"],
      ["form.json", "fallback.md"],
      ["changes.diff", "fallback.md"],
      ["diagram.mmd", "fallback.md"],
      ["content.html.txt", "fallback.md"],
      ["imported-report.txt", "fallback.md"],
      ["media.json", "media.png", "fallback.md"],
      ["brief.json", "fallback.md"],
    ]);
    const widgetProjection = artifactProjectionContents(snapshots.at(-1)!);
    expect(
      Buffer.concat(widgetProjection.map((item) => Buffer.from(item.content))).toString(),
    ).not.toContain("PRIVATE GENERATED SOURCE");
  });
});
