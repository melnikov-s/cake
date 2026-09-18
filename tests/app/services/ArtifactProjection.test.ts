import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
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
  const info = await lstat(target).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
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

  it("rejects symlinked cache and sessions roots without writing through them", async () => {
    for (const intermediate of ["cache", "sessions"] as const) {
      const root = await mkdtemp(join(tmpdir(), `cake-artifact-projection-${intermediate}-link-`));
      roots.push(root);
      const external = join(root, "external");
      const cacheRoot = join(root, "cache");
      await mkdir(external);
      await writeFile(join(external, "sentinel"), "keep");
      if (intermediate === "cache") {
        await symlink(external, cacheRoot);
      } else {
        const versionRoot = join(cacheRoot, "artifact-projections", "v1");
        await mkdir(versionRoot, { recursive: true });
        await symlink(external, join(versionRoot, "sessions"));
      }
      const layer = makeArtifactProjectionLive(cacheRoot).pipe(
        Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
      );
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ArtifactProjection;
          yield* service.materialize({
            sessionId: "session-1",
            revision: revision(markdown(1, "one")),
            latestRevision: revisionNumber(1),
            linkMode: "follow-latest",
          });
        }).pipe(Effect.provide(layer), Effect.flip),
      );
      expect(String(failure)).toContain("Unsafe projection path");
      expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep");
      await expect(stat(join(external, "session-1"))).rejects.toThrow();
    }
  });

  it("rejects replaced sessions directories before later mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifact-projection-replaced-root-"));
    roots.push(root);
    const cacheRoot = join(root, "cache");
    const layer = makeArtifactProjectionLive(cacheRoot).pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );
    const sessionsRoot = join(cacheRoot, "artifact-projections", "v1", "sessions");
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ArtifactProjection;
        yield* Effect.promise(async () => {
          await rename(sessionsRoot, `${sessionsRoot}-original`);
          await mkdir(sessionsRoot);
          await writeFile(join(sessionsRoot, "sentinel"), "keep");
        });
        return yield* service
          .materialize({
            sessionId: "session-1",
            revision: revision(markdown(1, "one")),
            latestRevision: revisionNumber(1),
            linkMode: "follow-latest",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    );
    expect(failure.message).toContain("Unsafe projection path");
    expect(await readFile(join(sessionsRoot, "sentinel"), "utf8")).toBe("keep");
    await expect(stat(join(sessionsRoot, "session-1"))).rejects.toThrow();
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

  it("unlinks descendant cleanup symlinks without traversing their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifact-projection-descendant-link-"));
    roots.push(root);
    const cacheRoot = join(root, "cache");
    const layer = makeArtifactProjectionLive(cacheRoot).pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "sentinel"), "keep");

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ArtifactProjection;
        yield* service.materialize({
          sessionId: "session-1",
          revision: revision(markdown(1, "one")),
          latestRevision: revisionNumber(1),
          linkMode: "follow-latest",
        });
        const sessionsRoot = join(cacheRoot, "artifact-projections", "v1", "sessions");
        const linkedSession = join(sessionsRoot, "linked-session");
        yield* Effect.promise(() => symlink(external, linkedSession));
        const failure = yield* service
          .materialize({
            sessionId: "linked-session",
            revision: revision(markdown(1, "escaped")),
            latestRevision: revisionNumber(1),
            linkMode: "follow-latest",
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("Unsafe projection path");
        expect(yield* Effect.promise(() => readFile(join(external, "sentinel"), "utf8"))).toBe(
          "keep",
        );

        const lineageRoot = join(sessionsRoot, "session-1", "escaped");
        yield* Effect.promise(() => symlink(external, lineageRoot));
        yield* service.cleanupLineage(
          "session-1",
          Schema.decodeUnknownSync(ArtifactLineageId)("escaped"),
        );
        expect(
          yield* Effect.promise(() => lstat(lineageRoot).catch(() => undefined)),
        ).toBeUndefined();
      }).pipe(Effect.provide(layer)),
    );
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep");
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
