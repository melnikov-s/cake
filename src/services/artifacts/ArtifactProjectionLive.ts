import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
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
      const configuredCacheRoot = path.resolve(cacheRoot);
      const sessionsRoot = path.join(
        configuredCacheRoot,
        "artifact-projections",
        `v${projectionVersion}`,
        "sessions",
      );
      const infrastructure = [
        configuredCacheRoot,
        path.join(configuredCacheRoot, "artifact-projections"),
        path.join(configuredCacheRoot, "artifact-projections", `v${projectionVersion}`),
        sessionsRoot,
      ];
      type EntryType = "missing" | "symlink" | "directory" | "file" | "other";
      interface DirectoryIdentity {
        readonly dev: number;
        readonly ino: number;
      }
      const trustedInfrastructure = new Map<string, DirectoryIdentity>();

      const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity) =>
        left.dev === right.dev && left.ino === right.ino;
      const isInside = (root: string, target: string) => {
        const relative = path.relative(root, target);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
      };
      const nodePromise = <A>(evaluate: () => Promise<A>) =>
        Effect.tryPromise({ try: evaluate, catch: (cause) => cause });
      const entry = Effect.fn("ArtifactProjection.entry")(function* (target: string) {
        return yield* nodePromise(async () => {
          try {
            const info = await lstat(target);
            const type: EntryType = info.isSymbolicLink()
              ? "symlink"
              : info.isDirectory()
                ? "directory"
                : info.isFile()
                  ? "file"
                  : "other";
            return { type, identity: { dev: info.dev, ino: info.ino } };
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
              return { type: "missing" as const };
            throw cause;
          }
        });
      });
      const canonicalPath = (target: string) => nodePromise(() => realpath(target));
      const unsafePath = (operation: string, target: string) =>
        projectionError(operation, `Unsafe projection path ${target}`);

      const ensureInfrastructure = Effect.fn("ArtifactProjection.ensureInfrastructure")(function* (
        operation: string,
      ) {
        for (const [index, target] of infrastructure.entries()) {
          let current = yield* entry(target).pipe(
            Effect.mapError((cause) => projectionError(operation, cause)),
          );
          if (current.type === "missing") {
            if (index === 0)
              yield* fileSystem
                .makeDirectory(target, { recursive: true })
                .pipe(Effect.mapError((cause) => projectionError(operation, cause)));
            else
              yield* fileSystem
                .makeDirectory(target)
                .pipe(Effect.mapError((cause) => projectionError(operation, cause)));
            current = yield* entry(target).pipe(
              Effect.mapError((cause) => projectionError(operation, cause)),
            );
            if (current.type !== "directory" || current.identity === undefined)
              return yield* unsafePath(operation, target);
            trustedInfrastructure.set(target, current.identity);
          } else {
            if (current.type !== "directory" || current.identity === undefined)
              return yield* unsafePath(operation, target);
            const trusted = trustedInfrastructure.get(target);
            if (trusted !== undefined && !sameIdentity(trusted, current.identity))
              return yield* unsafePath(operation, target);
            trustedInfrastructure.set(target, current.identity);
          }

          const canonical = yield* canonicalPath(target).pipe(
            Effect.mapError((cause) => projectionError(operation, cause)),
          );
          const canonicalRoot = yield* canonicalPath(configuredCacheRoot).pipe(
            Effect.mapError((cause) => projectionError(operation, cause)),
          );
          const expected = path.join(canonicalRoot, path.relative(configuredCacheRoot, target));
          if (canonical !== expected || !isInside(canonicalRoot, canonical))
            return yield* unsafePath(operation, target);
        }
      });

      const makeGuard = (operation: string) => {
        const trustedDirectories = new Map<string, DirectoryIdentity>();
        const validate = Effect.fn("ArtifactProjection.validatePath")(function* (
          target: string,
          leaf: "any" | "directory-or-missing" | "file",
        ) {
          if (!isInside(sessionsRoot, target)) return yield* unsafePath(operation, target);
          yield* ensureInfrastructure(operation);
          for (const [index, segment] of path
            .relative(sessionsRoot, target)
            .split(path.sep)
            .entries()) {
            if (segment === "") continue;
            const currentPath = path.join(
              sessionsRoot,
              ...path
                .relative(sessionsRoot, target)
                .split(path.sep)
                .slice(0, index + 1),
            );
            const isLeaf = currentPath === target;
            const current = yield* entry(currentPath).pipe(
              Effect.mapError((cause) => projectionError(operation, cause)),
            );
            if (current.type === "missing") {
              if (isLeaf && leaf !== "file") return "missing" as const;
              return yield* unsafePath(operation, currentPath);
            }
            if (!isLeaf || leaf === "directory-or-missing") {
              if (current.type !== "directory" || current.identity === undefined)
                return yield* unsafePath(operation, currentPath);
              const trusted = trustedDirectories.get(currentPath);
              if (trusted !== undefined && !sameIdentity(trusted, current.identity))
                return yield* unsafePath(operation, currentPath);
              trustedDirectories.set(currentPath, current.identity);
              const canonical = yield* canonicalPath(currentPath).pipe(
                Effect.mapError((cause) => projectionError(operation, cause)),
              );
              const canonicalSessions = yield* canonicalPath(sessionsRoot).pipe(
                Effect.mapError((cause) => projectionError(operation, cause)),
              );
              const expected = path.join(
                canonicalSessions,
                path.relative(sessionsRoot, currentPath),
              );
              if (canonical !== expected || !isInside(canonicalSessions, canonical))
                return yield* unsafePath(operation, currentPath);
            } else if (leaf === "file" && current.type !== "file") {
              return yield* unsafePath(operation, currentPath);
            }
            if (isLeaf) return current.type;
          }
          return "directory" as const;
        });

        const ensureDirectory = Effect.fn("ArtifactProjection.ensureDirectory")(function* (
          target: string,
        ) {
          if ((yield* validate(target, "directory-or-missing")) === "directory") return;
          yield* validate(path.dirname(target), "directory-or-missing");
          yield* fileSystem
            .makeDirectory(target)
            .pipe(Effect.mapError((cause) => projectionError(operation, cause)));
          yield* validate(target, "directory-or-missing");
        });

        const chmodDirectory = Effect.fn("ArtifactProjection.chmodDirectory")(function* (
          target: string,
          mode: number,
        ) {
          yield* validate(target, "directory-or-missing");
          const expected = trustedDirectories.get(target);
          if (expected === undefined) return yield* unsafePath(operation, target);
          yield* nodePromise(async () => {
            const handle = await open(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            try {
              const before = await handle.stat();
              if (!sameIdentity(expected, { dev: before.dev, ino: before.ino }))
                throw new Error(`Projection directory changed before chmod: ${target}`);
              await handle.chmod(mode);
              const after = await handle.stat();
              if (before.dev !== after.dev || before.ino !== after.ino)
                throw new Error(`Projection directory changed during chmod: ${target}`);
            } finally {
              await handle.close();
            }
          }).pipe(Effect.mapError((cause) => projectionError(operation, cause)));
          yield* validate(target, "directory-or-missing");
        });

        const writeNewFile = Effect.fn("ArtifactProjection.writeNewFile")(function* (
          target: string,
          content: Uint8Array | string,
        ) {
          if ((yield* validate(target, "any")) !== "missing")
            return yield* unsafePath(operation, target);
          yield* validate(path.dirname(target), "directory-or-missing");
          yield* nodePromise(async () => {
            const handle = await open(
              target,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            try {
              await handle.writeFile(content);
              await handle.chmod(0o444);
            } finally {
              await handle.close();
            }
          }).pipe(Effect.mapError((cause) => projectionError(operation, cause)));
          yield* validate(target, "file");
        });

        const removeTree: (target: string) => Effect.Effect<void, ArtifactProjectionError> =
          Effect.fn("ArtifactProjection.removeTree")(function* (target: string) {
            const type = yield* validate(target, "any");
            if (type === "missing") return;
            if (type !== "directory") {
              yield* validate(path.dirname(target), "directory-or-missing");
              yield* nodePromise(() => unlink(target)).pipe(
                Effect.mapError((cause) => projectionError(operation, cause)),
              );
              trustedDirectories.delete(target);
              yield* ensureInfrastructure(operation);
              yield* validate(path.dirname(target), "directory-or-missing");
              return;
            }
            yield* chmodDirectory(target, 0o755);
            const names = yield* fileSystem
              .readDirectory(target)
              .pipe(Effect.mapError((cause) => projectionError(operation, cause)));
            yield* validate(target, "directory-or-missing");
            for (const name of names) yield* removeTree(path.join(target, name));
            yield* validate(target, "directory-or-missing");
            yield* validate(path.dirname(target), "directory-or-missing");
            yield* nodePromise(() => rmdir(target)).pipe(
              Effect.mapError((cause) => projectionError(operation, cause)),
            );
            trustedDirectories.delete(target);
            yield* ensureInfrastructure(operation);
            yield* validate(path.dirname(target), "directory-or-missing");
          });

        return { chmodDirectory, ensureDirectory, removeTree, validate, writeNewFile };
      };

      yield* ensureInfrastructure("initialize");

      const materialize = Effect.fn("ArtifactProjection.materialize")(function* (
        input: MaterializeArtifactProjectionInput,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const guard = makeGuard("materialize");
            const sessionId = yield* Effect.try({
              try: () => requireSafeSegment("session ID", input.sessionId),
              catch: (cause) => projectionError("materialize", cause),
            });
            const lineageId = yield* Effect.try({
              try: () => requireSafeSegment("lineage ID", input.revision.lineageId),
              catch: (cause) => projectionError("materialize", cause),
            });
            const revisionName = `r${String(input.revision.metadata.revision).padStart(8, "0")}`;
            const sessionRoot = path.join(sessionsRoot, sessionId);
            const lineageRoot = path.join(sessionRoot, lineageId);
            const revisionsRoot = path.join(lineageRoot, "revisions");
            const revisionRoot = path.join(revisionsRoot, revisionName);
            const sessionType = yield* guard.validate(sessionRoot, "directory-or-missing");
            const lineageType =
              sessionType === "directory"
                ? yield* guard.validate(lineageRoot, "directory-or-missing")
                : "missing";
            const revisionsType =
              lineageType === "directory"
                ? yield* guard.validate(revisionsRoot, "directory-or-missing")
                : "missing";
            const revisionType =
              revisionsType === "directory"
                ? yield* guard.validate(revisionRoot, "directory-or-missing")
                : "missing";
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

            const reusable = yield* Effect.succeed(revisionType).pipe(
              Effect.flatMap((type) => {
                if (type === "missing") return Effect.succeed(false);
                return Effect.gen(function* () {
                  const metadataPath = path.join(revisionRoot, "metadata.json");
                  yield* guard.validate(metadataPath, "file");
                  const stored = yield* fileSystem.readFileString(metadataPath);
                  yield* guard.validate(metadataPath, "file");
                  const decoded = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(ArtifactProjectionMetadata),
                  )(stored);
                  if (JSON.stringify(decoded) !== JSON.stringify(metadata)) return false;
                  for (const [index, item] of values.entries()) {
                    yield* guard.validate(files[index]!.path, "file");
                    const storedFile = yield* fileSystem.readFile(files[index]!.path);
                    yield* guard.validate(files[index]!.path, "file");
                    if (sha256(storedFile) !== sha256(item.content)) return false;
                  }
                  return true;
                }).pipe(Effect.orElseSucceed(() => false));
              }),
              Effect.mapError((cause) => projectionError("materialize", cause)),
            );
            if (reusable) return metadata;

            if (revisionType === "directory") yield* guard.removeTree(revisionRoot);
            yield* guard.ensureDirectory(sessionRoot);
            yield* guard.ensureDirectory(lineageRoot);
            yield* guard.ensureDirectory(revisionsRoot);
            yield* guard.validate(revisionsRoot, "directory-or-missing");
            const temporary = yield* fileSystem
              .makeTempDirectory({ directory: revisionsRoot, prefix: ".materialize-" })
              .pipe(Effect.mapError((cause) => projectionError("materialize", cause)));
            yield* guard.validate(temporary, "directory-or-missing");
            const build = Effect.gen(function* () {
              for (const item of values)
                yield* guard.writeNewFile(path.join(temporary, item.name), item.content);
              yield* guard.writeNewFile(path.join(temporary, "metadata.json"), metadataContent);
              yield* guard.validate(temporary, "directory-or-missing");
              yield* guard.validate(revisionRoot, "directory-or-missing");
              yield* fileSystem
                .rename(temporary, revisionRoot)
                .pipe(Effect.mapError((cause) => projectionError("materialize", cause)));
              yield* guard.validate(revisionRoot, "directory-or-missing");
              yield* guard.chmodDirectory(revisionRoot, 0o555);
            });
            yield* build.pipe(
              Effect.onError(() =>
                guard.removeTree(temporary).pipe(Effect.catch(() => Effect.void)),
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
        yield* lock.withPermits(1)(
          makeGuard("cleanupSession").removeTree(path.join(sessionsRoot, safe)),
        );
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
            const guard = makeGuard("cleanupLineage");
            const sessionRoot = path.join(sessionsRoot, safeSession);
            const sessionType = yield* guard.validate(sessionRoot, "any");
            if (sessionType === "missing") return;
            yield* guard.validate(sessionRoot, "directory-or-missing");
            yield* guard.removeTree(path.join(sessionRoot, safeLineage));
          }),
        );
      });

      const cleanup = Effect.fn("ArtifactProjection.cleanup")(function* (
        input: Parameters<ArtifactProjection["Service"]["cleanup"]>[0],
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const guard = makeGuard("cleanup");
            yield* ensureInfrastructure("cleanup");
            const retainedBySession = new Map(
              input.retained.map((item) => [item.sessionId, new Set<string>(item.lineageIds)]),
            );
            const sessionNames = yield* fileSystem
              .readDirectory(sessionsRoot)
              .pipe(Effect.mapError((cause) => projectionError("cleanup", cause)));
            yield* ensureInfrastructure("cleanup");
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
              const sessionType = yield* guard.validate(sessionRoot, "any");
              if (!retainedLineages || sessionType !== "directory") {
                yield* guard.removeTree(sessionRoot);
                sessionsRemoved += 1;
                continue;
              }
              const lineageNames = yield* fileSystem
                .readDirectory(sessionRoot)
                .pipe(Effect.mapError((cause) => projectionError("cleanup", cause)));
              yield* guard.validate(sessionRoot, "directory-or-missing");
              for (const lineageName of lineageNames) {
                try {
                  requireSafeSegment("lineage ID", lineageName);
                } catch {
                  continue;
                }
                if (retainedLineages.has(lineageName)) continue;
                yield* guard.removeTree(path.join(sessionRoot, lineageName));
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
