import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { formatArtifactRef } from "../../domain/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import {
  ArtifactProjection,
  ArtifactProjectionError,
  ArtifactProjectionMetadata,
  type ArtifactProjectionFile,
  type MaterializeArtifactProjectionInput,
} from "./ArtifactProjection";

const projectionVersion = 1;
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
type HashInput = Uint8Array | string;
type ArtifactScalar = string | number | boolean | null | undefined;
const sha256 = (content: HashInput) => createHash("sha256").update(content).digest("hex");

interface ProjectionContent {
  readonly name: string;
  readonly content: Uint8Array;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
const textContent = (name: string, value: string): ProjectionContent => ({
  name,
  content: utf8(value),
});
const byteContent = (name: string, value: Uint8Array): ProjectionContent => ({
  name,
  content: value,
});

const csvValue = (value: ArtifactScalar) => {
  const rendered = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered;
};

const dataUrlBytes = (src: string): Uint8Array | undefined => {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!match) return undefined;
  try {
    return match[2]
      ? new Uint8Array(Buffer.from(match[3] ?? "", "base64"))
      : utf8(decodeURIComponent(match[3] ?? ""));
  } catch {
    return undefined;
  }
};

const mediaExtension = (src: string) => {
  const mime = /^data:([^;,]+)/i.exec(src)?.[1]?.toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "video/mp4") return "mp4";
  if (mime === "application/pdf") return "pdf";
  return "bin";
};

/** Canonical public files only. Widget implementation source is deliberately unreachable here. */
export const artifactProjectionContents = (snapshot: CakeArtifactV1): ProjectionContent[] => {
  const fallback = textContent("fallback.md", snapshot.fallback.markdown);
  switch (snapshot.kind) {
    case "markdown":
      return [textContent("content.md", snapshot.payload.markdown), fallback];
    case "table": {
      const headers = snapshot.payload.columns.map((column) => column.label);
      const rows = snapshot.payload.rows.map((row) =>
        snapshot.payload.columns.map((column) => csvValue(row[column.id])).join(","),
      );
      return [
        textContent("table.json", `${JSON.stringify(snapshot.payload, null, 2)}\n`),
        textContent("table.csv", `${headers.map(csvValue).join(",")}\n${rows.join("\n")}\n`),
        fallback,
      ];
    }
    case "form":
      return [textContent("form.json", `${JSON.stringify(snapshot.payload, null, 2)}\n`), fallback];
    case "diff":
      return [textContent("changes.diff", snapshot.payload.diff), fallback];
    case "diagram":
      return [textContent("diagram.mmd", snapshot.payload.source), fallback];
    case "html":
      return [textContent("content.html.txt", snapshot.payload.html), fallback];
    case "file":
      return [
        byteContent(
          `imported-${snapshot.payload.name}`,
          Buffer.from(snapshot.payload.data, "base64"),
        ),
        fallback,
      ];
    case "media": {
      const bytes = dataUrlBytes(snapshot.payload.src);
      return [
        textContent(
          "media.json",
          `${JSON.stringify(
            {
              mediaType: snapshot.payload.mediaType,
              src: bytes ? "snapshotted-data" : snapshot.payload.src,
              ...(snapshot.payload.alt === undefined ? null : { alt: snapshot.payload.alt }),
              ...(bytes === undefined ? null : { byteSize: bytes.byteLength }),
            },
            null,
            2,
          )}\n`,
        ),
        ...(bytes === undefined
          ? []
          : [byteContent(`media.${mediaExtension(snapshot.payload.src)}`, bytes)]),
        fallback,
      ];
    }
    case "widget":
      return [
        textContent(
          "brief.json",
          `${JSON.stringify(
            {
              language: snapshot.payload.language,
              brief: snapshot.payload.brief,
              generationSessionId: snapshot.payload.generationSessionId,
            },
            null,
            2,
          )}\n`,
        ),
        fallback,
      ];
    case "request":
      throw new Error("Blocking requests are not reusable artifact projections");
  }
};

const projectionError = (operation: string, cause: unknown) =>
  new ArtifactProjectionError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const requireSafeSegment = (label: string, value: string) => {
  if (!segmentPattern.test(value) || value === "." || value === "..")
    throw new Error(`Unsafe ${label}`);
  return value;
};

export const makeArtifactProjectionLive = (cacheRoot: string) =>
  Layer.effect(
    ArtifactProjection,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const sessionsRoot = path.join(
        cacheRoot,
        "artifact-projections",
        `v${projectionVersion}`,
        "sessions",
      );

      const entryType = Effect.fn("ArtifactProjection.entryType")(function* (target: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const info = await lstat(target);
            if (info.isSymbolicLink()) return "symlink" as const;
            if (info.isDirectory()) return "directory" as const;
            return "other" as const;
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            cause instanceof Error && "code" in cause && cause.code === "ENOENT"
              ? Effect.succeed("missing" as const)
              : Effect.fail(cause),
          ),
        );
      });
      const unlockTree: (target: string) => Effect.Effect<void, unknown> = Effect.fn(
        "ArtifactProjection.unlockTree",
      )(function* (target: string) {
        if ((yield* entryType(target)) !== "directory") return;
        yield* fileSystem.chmod(target, 0o755);
        const names = yield* fileSystem.readDirectory(target);
        yield* Effect.forEach(names, (name) => unlockTree(path.join(target, name)), {
          discard: true,
        });
      });
      const requireDirectoryOrMissing = Effect.fn("ArtifactProjection.requireDirectoryOrMissing")(
        function* (operation: string, target: string) {
          const type = yield* entryType(target).pipe(
            Effect.mapError((cause) => projectionError(operation, cause)),
          );
          if (type === "symlink" || type === "other")
            return yield* projectionError(operation, `Unsafe projection path ${target}`);
        },
      );
      const remove = (operation: string, target: string) =>
        unlockTree(target).pipe(
          Effect.andThen(fileSystem.remove(target, { recursive: true, force: true })),
          Effect.mapError((cause) => projectionError(operation, cause)),
        );

      const materialize = Effect.fn("ArtifactProjection.materialize")(function* (
        input: MaterializeArtifactProjectionInput,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const sessionId = yield* Effect.try({
              try: () => requireSafeSegment("session ID", input.sessionId),
              catch: (cause) => projectionError("materialize", cause),
            });
            const lineageId = yield* Effect.try({
              try: () => requireSafeSegment("lineage ID", input.revision.lineageId),
              catch: (cause) => projectionError("materialize", cause),
            });
            const revisionName = `r${String(input.revision.metadata.revision).padStart(8, "0")}`;
            const lineageRoot = path.join(sessionsRoot, sessionId, lineageId);
            const revisionsRoot = path.join(lineageRoot, "revisions");
            const revisionRoot = path.join(revisionsRoot, revisionName);
            yield* requireDirectoryOrMissing("materialize", path.join(sessionsRoot, sessionId));
            yield* requireDirectoryOrMissing("materialize", lineageRoot);
            yield* requireDirectoryOrMissing("materialize", revisionsRoot);
            yield* requireDirectoryOrMissing("materialize", revisionRoot);
            const latestPath = path.join(
              lineageRoot,
              "revisions",
              `r${String(input.latestRevision).padStart(8, "0")}`,
            );
            const values = yield* Effect.try({
              try: () => artifactProjectionContents(input.revision.snapshot),
              catch: (cause) => projectionError("materialize", cause),
            });
            const files: ArtifactProjectionFile[] = values.map((item) => ({
              name: item.name,
              path: path.join(revisionRoot, item.name),
              byteSize: item.content.byteLength,
              sha256: sha256(item.content),
            }));
            const stableRef = formatArtifactRef({ lineageId: input.revision.lineageId });
            const exactRef = formatArtifactRef({
              lineageId: input.revision.lineageId,
              revision: input.revision.metadata.revision,
            });
            const metadata: ArtifactProjectionMetadata = {
              lineageId,
              ...(input.revision.snapshot.title === undefined
                ? null
                : { title: input.revision.snapshot.title }),
              kind: input.revision.metadata.kind,
              selectedRevision: input.revision.metadata.revision,
              latestRevision: input.latestRevision,
              digest: input.revision.metadata.digest,
              linkMode: input.linkMode,
              stableRef,
              exactRef,
              exactPath: revisionRoot,
              ...(input.revision.metadata.revision === input.latestRevision
                ? { latestPath }
                : null),
              files,
            };
            const metadataContent = `${JSON.stringify(metadata, null, 2)}\n`;

            const reusable = yield* fileSystem.exists(revisionRoot).pipe(
              Effect.flatMap((exists) => {
                if (!exists) return Effect.succeed(false);
                return Effect.gen(function* () {
                  const stored = yield* fileSystem.readFileString(
                    path.join(revisionRoot, "metadata.json"),
                  );
                  const decoded = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(ArtifactProjectionMetadata),
                  )(stored);
                  if (JSON.stringify(decoded) !== JSON.stringify(metadata)) return false;
                  for (const [index, item] of values.entries()) {
                    const storedFile = yield* fileSystem.readFile(files[index]!.path);
                    if (sha256(storedFile) !== sha256(item.content)) return false;
                  }
                  return true;
                }).pipe(Effect.orElseSucceed(() => false));
              }),
              Effect.mapError((cause) => projectionError("materialize", cause)),
            );
            if (reusable) return metadata;

            yield* remove("materialize", revisionRoot);
            yield* fileSystem
              .makeDirectory(revisionsRoot, { recursive: true })
              .pipe(Effect.mapError((cause) => projectionError("materialize", cause)));
            const temporary = yield* fileSystem
              .makeTempDirectory({ directory: revisionsRoot, prefix: ".materialize-" })
              .pipe(Effect.mapError((cause) => projectionError("materialize", cause)));
            const build = Effect.gen(function* () {
              for (const item of values)
                yield* fileSystem.writeFile(path.join(temporary, item.name), item.content);
              yield* fileSystem.writeFileString(
                path.join(temporary, "metadata.json"),
                metadataContent,
              );
              for (const item of [...values.map((item) => item.name), "metadata.json"])
                yield* fileSystem.chmod(path.join(temporary, item), 0o444);
              yield* fileSystem.rename(temporary, revisionRoot);
              yield* fileSystem.chmod(revisionRoot, 0o555);
            }).pipe(Effect.mapError((cause) => projectionError("materialize", cause)));
            yield* build.pipe(
              Effect.onError(() =>
                remove("materializeCleanup", temporary).pipe(Effect.catch(() => Effect.void)),
              ),
            );
            return metadata;
          }),
        );
      });

      const cleanupSession = Effect.fn("ArtifactProjection.cleanupSession")(function* (
        sessionId: string,
      ) {
        const safe = yield* Effect.try({
          try: () => requireSafeSegment("session ID", sessionId),
          catch: (cause) => projectionError("cleanupSession", cause),
        });
        yield* lock.withPermits(1)(remove("cleanupSession", path.join(sessionsRoot, safe)));
      });
      const cleanupLineage = Effect.fn("ArtifactProjection.cleanupLineage")(function* (
        sessionId: string,
        lineageId: string,
      ) {
        const safeSession = yield* Effect.try({
          try: () => requireSafeSegment("session ID", sessionId),
          catch: (cause) => projectionError("cleanupLineage", cause),
        });
        const safeLineage = yield* Effect.try({
          try: () => requireSafeSegment("lineage ID", lineageId),
          catch: (cause) => projectionError("cleanupLineage", cause),
        });
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* requireDirectoryOrMissing(
              "cleanupLineage",
              path.join(sessionsRoot, safeSession),
            );
            yield* remove("cleanupLineage", path.join(sessionsRoot, safeSession, safeLineage));
          }),
        );
      });

      const cleanup = Effect.fn("ArtifactProjection.cleanup")(function* (
        input: Parameters<ArtifactProjection["Service"]["cleanup"]>[0],
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const retainedBySession = new Map(
              input.retained.map((item) => [item.sessionId, new Set<string>(item.lineageIds)]),
            );
            if (
              !(yield* fileSystem
                .exists(sessionsRoot)
                .pipe(Effect.mapError((cause) => projectionError("cleanup", cause))))
            )
              return { sessionsRemoved: 0, lineagesRemoved: 0 };
            const sessionNames = yield* fileSystem
              .readDirectory(sessionsRoot)
              .pipe(Effect.mapError((cause) => projectionError("cleanup", cause)));
            let sessionsRemoved = 0;
            let lineagesRemoved = 0;
            for (const sessionName of sessionNames) {
              try {
                requireSafeSegment("session ID", sessionName);
              } catch {
                continue;
              }
              const sessionRoot = path.join(sessionsRoot, sessionName);
              const retainedLineages = retainedBySession.get(sessionName);
              const sessionType = yield* entryType(sessionRoot).pipe(
                Effect.mapError((cause) => projectionError("cleanup", cause)),
              );
              if (!retainedLineages || sessionType !== "directory") {
                yield* remove("cleanup", sessionRoot);
                sessionsRemoved += 1;
                continue;
              }
              const lineageNames = yield* fileSystem.readDirectory(sessionRoot).pipe(
                Effect.mapError((cause) => projectionError("cleanup", cause)),
                Effect.catch(() => Effect.succeed([])),
              );
              for (const lineageName of lineageNames) {
                try {
                  requireSafeSegment("lineage ID", lineageName);
                } catch {
                  continue;
                }
                if (retainedLineages.has(lineageName)) continue;
                yield* remove("cleanup", path.join(sessionRoot, lineageName));
                lineagesRemoved += 1;
              }
            }
            return { sessionsRemoved, lineagesRemoved };
          }),
        );
      });

      return ArtifactProjection.of({ materialize, cleanupSession, cleanupLineage, cleanup });
    }),
  );
