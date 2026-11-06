import { WidgetBrowserOutput } from "../../contracts/widgets/widget-browser-output";
import { DateTime, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import {
  ArtifactCatalog,
  ArtifactDigest,
  type ArtifactLineageId,
  ArtifactLink,
  ArtifactRevision,
  ArtifactRevisionNumber,
  type ArtifactLineage,
  type ArtifactRevisionMetadata,
} from "../../contracts/artifacts/artifact-lineage";
import { ArtifactPublicationConflict } from "../../contracts/storage/artifact-storage-errors";
import { ArtifactStorage, type ArtifactCollectionInput } from "./ArtifactStorage";
import { atomicWriteFile } from "./internal/atomicFile";

import {
  type ArtifactState,
  ArtifactStateConflict,
  ArtifactStateReplacement,
} from "../../contracts/artifacts/artifact-state";

import {
  CATALOG_VERSION,
  StoredArtifactHeader,
  decodeBlob,
  decodeCatalog,
  digest,
  targetKey,
  linkKey,
  storageError,
  validateCatalog,
} from "./artifactStorageCodec";
import { makeLegacyArtifactMigration } from "./artifactLegacyMigration";

export const makeArtifactStorageLive = (root: string) =>
  Layer.effect(
    ArtifactStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const catalogPath = path.join(root, "catalog.json");
      // Transaction scratch, refreshed from disk under the same repository lock on every load.
      // The envelope is replaced atomically; it contains only the current value, never state history.
      let currentStates: ReadonlyArray<ArtifactState> = [];
      const stateFor = (lineageId: ArtifactLineageId): ArtifactState =>
        currentStates.find((state) => state.lineageId === lineageId) ?? {
          lineageId,
          version: 0,
          value: null,
        };
      const replaceCurrentState = (next: ArtifactState) => {
        currentStates = [
          ...currentStates.filter((state) => state.lineageId !== next.lineageId),
          next,
        ];
      };
      const blobDirectory = path.join(root, "blobs");
      const blobPath = (value: string) => path.join(blobDirectory, `${value}.json`);

      const readText = (operation: string, target: string) =>
        fileSystem
          .readFileString(target)
          .pipe(Effect.mapError((cause) => storageError(operation, cause)));
      const writeText = (operation: string, target: string, content: string) =>
        atomicWriteFile(fileSystem, path, target, content, (stage, cause) =>
          storageError(`${operation}:${stage}`, cause),
        );

      const saveUnlocked = Effect.fn("ArtifactStorage.saveUnlocked")(function* (
        input: ArtifactCatalog,
      ) {
        const catalog = yield* Effect.try({
          try: () => validateCatalog(input),
          catch: (cause) => storageError("save", cause),
        });
        const encoded = yield* Schema.encodeEffect(ArtifactCatalog)(catalog).pipe(
          Effect.mapError((cause) => storageError("save", cause)),
        );
        yield* writeText(
          "save",
          catalogPath,
          `${JSON.stringify({ version: CATALOG_VERSION, data: { ...encoded, states: currentStates.filter((state) => catalog.lineages.some((lineage) => lineage.id === state.lineageId)) } }, null, 2)}\n`,
        );
      });

      const migrateLegacyUnlocked = makeLegacyArtifactMigration({
        root,
        fileSystem,
        path,
        readText,
        writeText,
      });

      const loadUnlocked = Effect.fn("ArtifactStorage.loadUnlocked")(function* () {
        const exists = yield* fileSystem
          .exists(catalogPath)
          .pipe(Effect.mapError((cause) => storageError("load", cause)));
        if (!exists) {
          currentStates = [];
          const migrated = yield* migrateLegacyUnlocked();
          yield* saveUnlocked(migrated);
          return migrated;
        }
        const decoded = yield* decodeCatalog(yield* readText("load", catalogPath));
        let current = decoded.catalog;
        currentStates = decoded.states;
        if (decoded.version < 4) {
          // Backfill catalog titles without rewriting immutable source or requiring
          // unrelated historical widgets to satisfy today's browser-output contract.
          current = {
            ...current,
            lineages: yield* Effect.forEach(current.lineages, (lineage) =>
              Effect.gen(function* () {
                const revisions = yield* Effect.forEach(lineage.revisions, (metadata) =>
                  Effect.gen(function* () {
                    const serialized = yield* readText("migrateTitles", blobPath(metadata.digest));
                    if (digest(serialized) !== metadata.digest)
                      return yield* storageError(
                        "migrateTitles",
                        "Artifact blob digest does not match",
                      );
                    const header = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(StoredArtifactHeader),
                    )(serialized).pipe(
                      Effect.mapError((cause) => storageError("migrateTitles", cause)),
                    );
                    if (header.id !== lineage.id || header.revision !== metadata.revision)
                      return yield* storageError(
                        "migrateTitles",
                        "Artifact header does not match catalog",
                      );
                    return {
                      ...metadata,
                      ...(header.title === undefined ? null : { title: header.title }),
                    };
                  }),
                );
                return { ...lineage, revisions };
              }),
            ),
          };
        }
        if (decoded.version < CATALOG_VERSION) yield* saveUnlocked(current);
        return yield* Effect.try({
          try: () => validateCatalog(current),
          catch: (cause) => storageError("load", cause),
        });
      });

      const readRevisionUnlocked = Effect.fn("ArtifactStorage.readRevisionUnlocked")(function* (
        catalog: ArtifactCatalog,
        lineageId: ArtifactLineageId,
        requestedRevision?: ArtifactRevisionNumber,
      ) {
        const lineage = catalog.lineages.find((candidate) => candidate.id === lineageId);
        if (!lineage) return undefined;
        const metadata = lineage.revisions.find(
          (candidate) => candidate.revision === (requestedRevision ?? lineage.latestRevision),
        );
        if (!metadata) return undefined;
        const serialized = yield* readText("read", blobPath(metadata.digest));
        if (digest(serialized) !== metadata.digest)
          return yield* storageError(
            "read",
            `Artifact ${lineageId}@r${metadata.revision} blob digest does not match`,
          );
        const decoded = yield* decodeBlob(serialized);
        if (
          decoded.snapshot.id !== lineageId ||
          decoded.snapshot.revision !== metadata.revision ||
          decoded.snapshot.sessionId !== metadata.publishedBySessionId ||
          decoded.storedKind !== metadata.kind
        )
          return yield* storageError(
            "read",
            `Artifact ${lineageId}@r${metadata.revision} metadata does not match its blob`,
          );
        return yield* Schema.decodeUnknownEffect(ArtifactRevision)({
          lineageId,
          metadata,
          snapshot: decoded.snapshot,
        }).pipe(Effect.mapError((cause) => storageError("read", cause)));
      });

      const publishUnlocked = Effect.fn("ArtifactStorage.publishUnlocked")(function* (
        input: Parameters<ArtifactStorage["Service"]["publish"]>[0],
        initialLink?: ArtifactLink,
      ) {
        const catalog = yield* loadUnlocked();
        const lineage = catalog.lineages.find((candidate) => candidate.id === input.lineageId);
        const actualLatestRevision = lineage?.latestRevision ?? 0;
        if (actualLatestRevision !== input.expectedLatestRevision)
          return yield* new ArtifactPublicationConflict({
            lineageId: input.lineageId,
            expectedLatestRevision: input.expectedLatestRevision,
            actualLatestRevision,
          });
        const stagedState =
          input.stagedState === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(ArtifactStateReplacement)({
                lineageId: input.lineageId,
                ...input.stagedState,
              }).pipe(Effect.mapError((cause) => storageError("publishState", cause)));
        const previousState = stateFor(input.lineageId);
        if (stagedState && previousState.version !== stagedState.expectedVersion)
          return yield* new ArtifactStateConflict({
            lineageId: input.lineageId,
            expectedVersion: stagedState.expectedVersion,
            actualVersion: previousState.version,
          });
        if (stagedState && input.snapshot.kind !== "widget")
          return yield* storageError("publishState", "Only widgets own mutable state");
        const nextRevision = actualLatestRevision + 1;
        if (input.snapshot.id !== input.lineageId || input.snapshot.revision !== nextRevision)
          return yield* storageError(
            "publish",
            "Artifact snapshot identity/revision must match the lineage next revision",
          );
        if (
          input.restoredFromRevision !== undefined &&
          (input.restoredFromRevision > actualLatestRevision || actualLatestRevision === 0)
        )
          return yield* storageError("publish", "Restore source must be an existing revision");
        if (
          initialLink &&
          (actualLatestRevision !== 0 ||
            initialLink.lineageId !== input.lineageId ||
            (initialLink.selection.mode === "pinned" && initialLink.selection.revision !== 1))
        )
          return yield* storageError("publishWithLink", "Initial link must select revision one");
        const serialized = `${JSON.stringify(input.snapshot, null, 2)}\n`;
        const blobDigest = yield* Schema.decodeUnknownEffect(ArtifactDigest)(
          digest(serialized),
        ).pipe(Effect.mapError((cause) => storageError("publish", cause)));
        const targetBlob = blobPath(blobDigest);
        if (
          yield* fileSystem
            .exists(targetBlob)
            .pipe(Effect.mapError((cause) => storageError("publish", cause)))
        ) {
          const existing = yield* readText("publish", targetBlob);
          if (existing !== serialized || digest(existing) !== blobDigest)
            return yield* storageError(
              "publish",
              `Existing content-addressed blob ${blobDigest} is corrupt`,
            );
        } else yield* writeText("publish", targetBlob, serialized);
        const now = DateTime.formatIso(yield* DateTime.now);
        const revision = yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
          nextRevision,
        ).pipe(Effect.mapError((cause) => storageError("publish", cause)));
        const metadata: ArtifactRevisionMetadata = {
          revision,
          digest: blobDigest,
          kind: input.snapshot.kind,
          publishedAt: now,
          publishedBySessionId: input.snapshot.sessionId,
          ...(input.snapshot.title === undefined ? null : { title: input.snapshot.title }),
          ...(input.snapshot.description === undefined
            ? null
            : { description: input.snapshot.description }),
          workingDirectory: input.workingDirectory,
          ...(input.restoredFromRevision === undefined
            ? null
            : { restoredFromRevision: input.restoredFromRevision }),
        };
        const nextLineage: ArtifactLineage = lineage
          ? {
              ...lineage,
              latestRevision: revision,
              revisions: [...lineage.revisions, metadata],
            }
          : {
              id: input.lineageId,
              global: input.global ?? false,
              createdAt: now,
              latestRevision: revision,
              revisions: [metadata],
            };
        if (stagedState)
          replaceCurrentState({
            lineageId: input.lineageId,
            version: previousState.version + 1,
            value: stagedState.value,
          });
        yield* saveUnlocked({
          lineages: lineage
            ? catalog.lineages.map((candidate) =>
                candidate.id === input.lineageId ? nextLineage : candidate,
              )
            : [...catalog.lineages, nextLineage],
          links: initialLink ? [...catalog.links, initialLink] : catalog.links,
        });
        return yield* Schema.decodeUnknownEffect(ArtifactRevision)({
          lineageId: input.lineageId,
          metadata,
          snapshot: input.snapshot,
        }).pipe(Effect.mapError((cause) => storageError("publish", cause)));
      });

      const publish = Effect.fn("ArtifactStorage.publish")((input) =>
        lock.withPermits(1)(publishUnlocked(input)),
      );
      const publishWithLink = Effect.fn("ArtifactStorage.publishWithLink")((input, link) =>
        lock.withPermits(1)(
          Schema.decodeUnknownEffect(ArtifactLink)(link).pipe(
            Effect.mapError((cause) => storageError("publishWithLink", cause)),
            Effect.flatMap((decoded) => publishUnlocked(input, decoded)),
          ),
        ),
      );

      const read = Effect.fn("ArtifactStorage.read")((lineageId, revision) =>
        lock.withPermits(1)(
          loadUnlocked().pipe(
            Effect.flatMap((catalog) => readRevisionUnlocked(catalog, lineageId, revision)),
          ),
        ),
      );
      const listRevisions = Effect.fn("ArtifactStorage.listRevisions")((lineageId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            const lineage = catalog.lineages.find((candidate) => candidate.id === lineageId);
            if (!lineage) return [];
            return yield* Effect.forEach(lineage.revisions, (metadata) =>
              readRevisionUnlocked(catalog, lineageId, metadata.revision).pipe(
                Effect.flatMap((revision) =>
                  revision === undefined
                    ? storageError("listRevisions", `Missing revision ${metadata.revision}`)
                    : Effect.succeed(revision),
                ),
              ),
            );
          }),
        ),
      );
      const putLink = Effect.fn("ArtifactStorage.putLink")((input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const link = yield* Schema.decodeUnknownEffect(ArtifactLink)(input).pipe(
              Effect.mapError((cause) => storageError("putLink", cause)),
            );
            const catalog = yield* loadUnlocked();
            const lineage = catalog.lineages.find((candidate) => candidate.id === link.lineageId);
            if (!lineage) return yield* storageError("putLink", "Artifact lineage does not exist");
            const selection = link.selection;
            if (
              selection.mode === "pinned" &&
              !lineage.revisions.some((item) => item.revision === selection.revision)
            )
              return yield* storageError("putLink", "Pinned artifact revision does not exist");
            const key = linkKey(link);
            yield* saveUnlocked({
              ...catalog,
              links: [...catalog.links.filter((candidate) => linkKey(candidate) !== key), link],
            });
          }),
        ),
      );
      const removeLink = Effect.fn("ArtifactStorage.removeLink")((target, lineageId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            yield* saveUnlocked({
              ...catalog,
              links: catalog.links.filter(
                (link) =>
                  !(link.lineageId === lineageId && targetKey(link.target) === targetKey(target)),
              ),
            });
          }),
        ),
      );
      const resolveLinks = Effect.fn("ArtifactStorage.resolveLinks")(
        (selectLinks: (links: ReadonlyArray<ArtifactLink>) => ReadonlyArray<ArtifactLink>) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const catalog = yield* loadUnlocked();
              return yield* Effect.forEach(
                selectLinks(catalog.links),
                Effect.fn("ArtifactStorage.resolveLink")(function* (link: ArtifactLink) {
                  const lineage = catalog.lineages.find(
                    (candidate) => candidate.id === link.lineageId,
                  );
                  if (!lineage)
                    return yield* storageError("resolveLinks", `Missing lineage ${link.lineageId}`);
                  const revision =
                    link.selection.mode === "pinned"
                      ? link.selection.revision
                      : lineage.latestRevision;
                  const value = yield* readRevisionUnlocked(catalog, link.lineageId, revision);
                  if (!value)
                    return yield* storageError(
                      "resolveLinks",
                      `Missing revision ${link.lineageId}@r${revision}`,
                    );
                  return { revision: value, link, latestRevision: lineage.latestRevision };
                }),
              );
            }),
          ),
      );
      const removeTargetLinks = Effect.fn("ArtifactStorage.removeTargetLinks")((target) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            yield* saveUnlocked({
              ...catalog,
              links: catalog.links.filter(
                (candidate) => targetKey(candidate.target) !== targetKey(target),
              ),
            });
          }),
        ),
      );
      const catalogToken = (value: ArtifactCatalog) => digest(JSON.stringify(value));
      const catalog = Effect.fn("ArtifactStorage.catalog")(() =>
        lock.withPermits(1)(loadUnlocked()),
      );
      const collectionSnapshot = Effect.fn("ArtifactStorage.collectionSnapshot")(() =>
        lock.withPermits(1)(
          loadUnlocked().pipe(Effect.map((catalog) => ({ catalog, token: catalogToken(catalog) }))),
        ),
      );
      const browserReference = Schema.Struct({
        kind: Schema.Literal("widget"),
        payload: Schema.Struct({ browser: WidgetBrowserOutput }),
      });
      const browserDigestFromBlob = Effect.fn("ArtifactStorage.browserDigestFromBlob")(function* (
        target: string,
      ) {
        const serialized = yield* readText("browserOutputGC", target);
        const browser = Schema.decodeUnknownOption(Schema.fromJsonString(browserReference))(
          serialized,
        );
        return browser._tag === "Some" ? browser.value.payload.browser.digest : undefined;
      });
      const retainedBrowserDigests = Effect.fn("ArtifactStorage.retainedBrowserDigests")(function* (
        catalog: ArtifactCatalog,
      ) {
        const retained = new Set<string>();
        for (const lineage of catalog.lineages)
          for (const revision of lineage.revisions) {
            const browser = yield* browserDigestFromBlob(blobPath(revision.digest));
            if (browser) retained.add(browser);
          }
        return retained;
      });
      const removeBrowserOutput = Effect.fn("ArtifactStorage.removeBrowserOutput")(function* (
        browser: string | undefined,
        retained: ReadonlySet<string>,
      ) {
        if (browser && !retained.has(browser))
          yield* fileSystem
            .remove(path.join(root, "browser-outputs", browser), { recursive: true, force: true })
            .pipe(Effect.mapError((cause) => storageError("browserOutputGC", cause)));
      });
      const setArtifactGlobal = Effect.fn("ArtifactStorage.setArtifactGlobal")(
        (lineageId: ArtifactLineageId, global: boolean) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const catalog = yield* loadUnlocked();
              if (!catalog.lineages.some((lineage) => lineage.id === lineageId))
                return yield* storageError("setArtifactGlobal", "Artifact lineage does not exist");
              yield* saveUnlocked({
                ...catalog,
                lineages: catalog.lineages.map((lineage) =>
                  lineage.id === lineageId ? { ...lineage, global } : lineage,
                ),
              });
            }),
          ),
      );
      const deleteArtifact = Effect.fn("ArtifactStorage.deleteArtifact")(
        (lineageId: ArtifactLineageId) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const catalog = yield* loadUnlocked();
              const removed = catalog.lineages.find((lineage) => lineage.id === lineageId);
              if (!removed)
                return yield* storageError("deleteArtifact", "Artifact lineage does not exist");
              const retained: ArtifactCatalog = {
                lineages: catalog.lineages.filter((lineage) => lineage.id !== lineageId),
                links: catalog.links.filter((link) => link.lineageId !== lineageId),
              };
              yield* saveUnlocked(retained);
              const retainedDigests = new Set(
                retained.lineages.flatMap((lineage) =>
                  lineage.revisions.map((revision) => revision.digest),
                ),
              );
              const retainedBrowsers = yield* retainedBrowserDigests(retained);
              for (const revision of removed.revisions) {
                if (retainedDigests.has(revision.digest)) continue;
                const target = blobPath(revision.digest);
                yield* removeBrowserOutput(yield* browserDigestFromBlob(target), retainedBrowsers);
                yield* fileSystem
                  .remove(target, { force: true })
                  .pipe(Effect.mapError((cause) => storageError("deleteArtifact", cause)));
              }
              yield* fileSystem
                .remove(path.join(root, "boards", digest(lineageId)), {
                  recursive: true,
                  force: true,
                })
                .pipe(Effect.mapError((cause) => storageError("deleteArtifact", cause)));
            }),
          ),
      );
      const collectUnreachable = Effect.fn("ArtifactStorage.collectUnreachable")(function* (
        input: ArtifactCollectionInput,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* loadUnlocked();
            if (catalogToken(current) !== input.expectedCatalogToken)
              return {
                skipped: true,
                lineagesRemoved: 0,
                revisionsRemoved: 0,
                linksRemoved: 0,
                blobsRemoved: 0,
              };

            const sessions = new Set(input.survivingSessionIds);
            const families = new Set(input.survivingFamilyIds);
            const transcriptLineages = new Set(input.transcriptLineageIds);
            const retainedLinks = current.links.filter((link) =>
              link.target.type === "session"
                ? sessions.has(link.target.sessionId)
                : families.has(link.target.familyId),
            );
            const retainedLineageIds = new Set<string>([
              ...transcriptLineages,
              ...current.lineages.filter((lineage) => lineage.global).map((lineage) => lineage.id),
              ...retainedLinks.map((link) => link.lineageId),
            ]);
            const retainedLineages = current.lineages.filter((lineage) =>
              retainedLineageIds.has(lineage.id),
            );
            const removedLineages = current.lineages.filter(
              (lineage) => !retainedLineageIds.has(lineage.id),
            );
            const retainedIdSet = new Set(retainedLineages.map((lineage) => lineage.id));
            const nextLinks = retainedLinks.filter((link) => retainedIdSet.has(link.lineageId));
            const linksRemoved = current.links.length - nextLinks.length;
            if (removedLineages.length > 0 || linksRemoved > 0)
              yield* saveUnlocked({ lineages: retainedLineages, links: nextLinks });

            const retainedDigests = new Set<string>(
              retainedLineages.flatMap((lineage) =>
                lineage.revisions.map((revision) => revision.digest),
              ),
            );
            const hasBlobDirectory = yield* fileSystem
              .exists(blobDirectory)
              .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
            const blobNames = hasBlobDirectory
              ? yield* fileSystem
                  .readDirectory(blobDirectory)
                  .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)))
              : [];
            // Board entries and receipts share artifact reachability, but are not revision blobs.
            const boardDirectory = path.join(root, "boards");
            const retainedBoards = new Set(retainedLineages.map((lineage) => digest(lineage.id)));
            if (
              yield* fileSystem
                .exists(boardDirectory)
                .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)))
            ) {
              const boards = yield* fileSystem
                .readDirectory(boardDirectory)
                .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
              for (const name of boards) {
                if (!/^[a-f0-9]{64}$/.test(name) || retainedBoards.has(name)) continue;
                yield* fileSystem
                  .remove(path.join(boardDirectory, name), { recursive: true, force: true })
                  .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
              }
            }
            // Resolve every surviving browser reference before deleting any output. The
            // repository lock also protects this decision from concurrent publication.
            const retainedBrowsers = yield* retainedBrowserDigests({
              lineages: retainedLineages,
              links: nextLinks,
            });
            let blobsRemoved = 0;
            for (const name of blobNames) {
              const match = /^([a-f0-9]{64})\.json$/.exec(name);
              if (!match || retainedDigests.has(match[1]!)) continue;
              const browser = yield* browserDigestFromBlob(path.join(blobDirectory, name));
              yield* removeBrowserOutput(browser, retainedBrowsers);
              yield* fileSystem
                .remove(path.join(blobDirectory, name), { force: true })
                .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
              blobsRemoved += 1;
            }
            return {
              skipped: false,
              lineagesRemoved: removedLineages.length,
              revisionsRemoved: removedLineages.reduce(
                (count, lineage) => count + lineage.revisions.length,
                0,
              ),
              linksRemoved,
              blobsRemoved,
            };
          }),
        );
      });
      const deleteBlobIfOrphaned = Effect.fn("ArtifactStorage.deleteBlobIfOrphaned")((value) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* loadUnlocked();
            if (
              current.lineages.some((lineage) =>
                lineage.revisions.some((revision) => revision.digest === value),
              )
            )
              return false;
            const target = blobPath(value);
            if (
              !(yield* fileSystem
                .exists(target)
                .pipe(Effect.mapError((cause) => storageError("deleteBlobIfOrphaned", cause))))
            )
              return false;
            const browser = yield* browserDigestFromBlob(target);
            if (browser)
              yield* removeBrowserOutput(browser, yield* retainedBrowserDigests(current));
            yield* fileSystem
              .remove(target, { force: true })
              .pipe(Effect.mapError((cause) => storageError("deleteBlobIfOrphaned", cause)));
            return true;
          }),
        ),
      );

      const readState = Effect.fn("ArtifactStorage.readState")((lineageId: ArtifactLineageId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            const lineage = catalog.lineages.find((item) => item.id === lineageId);
            if (!lineage || lineage.revisions.at(-1)?.kind !== "widget")
              return yield* storageError(
                "readState",
                "Mutable state requires an existing widget artifact",
              );
            return stateFor(lineageId);
          }),
        ),
      );
      const replaceState = Effect.fn("ArtifactStorage.replaceState")(
        (input: ArtifactStateReplacement) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(ArtifactStateReplacement)(
                input,
              ).pipe(Effect.mapError((cause) => storageError("replaceState", cause)));
              const catalog = yield* loadUnlocked();
              const lineage = catalog.lineages.find((item) => item.id === decoded.lineageId);
              if (!lineage || lineage.revisions.at(-1)?.kind !== "widget")
                return yield* storageError(
                  "replaceState",
                  "Mutable state requires an existing widget artifact",
                );
              const previous = stateFor(decoded.lineageId);
              if (previous.version !== decoded.expectedVersion)
                return yield* new ArtifactStateConflict({
                  lineageId: decoded.lineageId,
                  expectedVersion: decoded.expectedVersion,
                  actualVersion: previous.version,
                });
              const next: ArtifactState = {
                lineageId: decoded.lineageId,
                version: previous.version + 1,
                value: decoded.value,
              };
              replaceCurrentState(next);
              yield* saveUnlocked(catalog);
              return next;
            }),
          ),
      );

      return ArtifactStorage.of({
        readState,
        replaceState,
        publish,
        publishWithLink,
        read,
        listRevisions,
        putLink,
        removeLink,
        resolveLinks,
        removeTargetLinks,
        catalog,
        setArtifactGlobal,
        deleteArtifact,
        collectionSnapshot,
        collectUnreachable,
        deleteBlobIfOrphaned,
      });
    }),
  );
