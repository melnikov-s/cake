import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect } from "effect";
import {
  decodeBlob,
  decodeCatalog,
  validateCatalog,
} from "../../../../src/services/storage/artifactStorageCodec";

const lineage = {
  id: "scores",
  createdAt: "2026-01-01",
  latestRevision: 1,
  revisions: [
    {
      revision: 1,
      digest: "a".repeat(64),
      kind: "table",
      publishedAt: "2026-01-01",
      publishedBySessionId: "publisher",
      workingDirectory: "/project",
    },
  ],
};
const state = { lineageId: "scores", version: 2, value: { selected: "one" } };
const link = {
  lineageId: "scores",
  target: { type: "session", sessionId: "reader" },
  selection: { mode: "pinned", revision: 1 },
  createdAt: "2026-01-01",
};

describe("artifact persisted codecs", () => {
  it.effect.each([1, 2, 3, 4, 5])(
    "decodes catalog v%i without changing lineage/link identity",
    (version) =>
      Effect.gen(function* () {
        const decoded = yield* decodeCatalog(
          JSON.stringify({
            version,
            data: {
              lineages: [version === 5 ? { ...lineage, global: true } : lineage],
              links: [
                version === 1
                  ? {
                      lineageId: "scores",
                      sessionId: "reader",
                      revision: 1,
                      createdAt: link.createdAt,
                    }
                  : link,
              ],
              ...(version >= 3 ? { states: [state] } : {}),
            },
          }),
        );
        expect(decoded.version).toBe(version);
        expect(validateCatalog(decoded.catalog)).toEqual({
          lineages: [{ ...lineage, global: version === 5 }],
          links: [link],
        });
        expect(decoded.states).toEqual(version >= 3 ? [state] : []);
      }),
  );

  it.effect.each([3, 4, 5])("rejects duplicate and orphaned current states in v%i", (version) =>
    Effect.gen(function* () {
      for (const states of [[state, state], [{ ...state, lineageId: "missing" }]]) {
        const error = yield* decodeCatalog(
          JSON.stringify({
            version,
            data: { lineages: [{ ...lineage, global: false }], links: [link], states },
          }),
        ).pipe(Effect.flip);
        expect(error.operation).toBe("load");
        expect(error.message).toBe("Invalid artifact current-state collection");
      }
    }),
  );

  it.effect("rejects future catalog versions and malformed envelopes as typed load failures", () =>
    Effect.gen(function* () {
      for (const text of ["not JSON", JSON.stringify({ version: 6, data: {} })]) {
        const error = yield* decodeCatalog(text).pipe(Effect.flip);
        expect(error._tag).toBe("ArtifactStorageError");
        expect(error.operation).toBe("load");
      }
    }),
  );

  it.effect("keeps catalog validation for revision gaps and missing pinned revisions", () =>
    Effect.gen(function* () {
      const gap = yield* decodeCatalog(
        JSON.stringify({
          version: 2,
          data: {
            lineages: [{ ...lineage, revisions: [{ ...lineage.revisions[0], revision: 2 }] }],
            links: [],
          },
        }),
      );
      expect(() => validateCatalog(gap.catalog)).toThrow("non-contiguous revision index");
      const missing = yield* decodeCatalog(
        JSON.stringify({
          version: 2,
          data: {
            lineages: [lineage],
            links: [{ ...link, selection: { mode: "pinned", revision: 2 } }],
          },
        }),
      );
      expect(() => validateCatalog(missing.catalog)).toThrow("pins missing revision scores@r2");
    }),
  );

  it.effect(
    "decodes historical architecture as fallback markdown while retaining stored kind",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeBlob(
          JSON.stringify({
            protocol: "cake.artifact/v1",
            id: "diagram",
            sessionId: "publisher",
            revision: 1,
            kind: "architecture",
            title: "Original",
            payload: { retired: true },
            fallback: { markdown: "Retained diagram" },
          }),
        );
        expect(decoded.storedKind).toBe("architecture");
        expect(decoded.snapshot).toMatchObject({
          id: "diagram",
          sessionId: "publisher",
          revision: 1,
          kind: "markdown",
          title: "Original",
          payload: { markdown: "Retained diagram" },
          interaction: { mode: "present" },
        });
      }),
  );
});
