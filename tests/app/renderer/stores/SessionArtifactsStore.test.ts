import { Schema } from "effect";
import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { EffectiveArtifactProjection } from "../../../../src/domain/artifacts/artifact-lineage";
import type { Client } from "../../../../src/renderer/client/Client";
import { ArtifactCatalog } from "../../../../src/renderer/models/ArtifactCatalog";
import { SessionArtifactsStore } from "../../../../src/renderer/stores/SessionArtifactsStore";
import { mountWithClient } from "../mount-with-client";

const effective = (sessionId: string, revision: number, title: string) =>
  Schema.decodeUnknownSync(EffectiveArtifactProjection)({
    revision: {
      lineageId: "shared",
      metadata: {
        revision,
        digest: "a".repeat(64),
        kind: "markdown",
        publishedAt: `2025-01-0${revision}T00:00:00.000Z`,
        publishedBySessionId: sessionId,
        workingDirectory: "/project",
      },
      snapshot: {
        protocol: "cake.artifact/v1",
        id: "shared",
        sessionId,
        revision,
        title,
        kind: "markdown",
        payload: { markdown: title },
        fallback: { markdown: title },
      },
    },
    link: {
      lineageId: "shared",
      target: { type: "family", familyId: "family-1" },
      selection: { mode: "follow-latest" },
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    latestRevision: revision,
    stableRef: "cake://artifact/shared",
    exactRef: `cake://artifact/shared@r${revision}`,
  });

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("SessionArtifactsStore", () => {
  it("keeps one canonical lineage identity across multiple session panels", async () => {
    const model = ArtifactCatalog.create();
    const pending: Array<(value: ReturnType<typeof effective>[]) => void> = [];
    const client = {
      artifacts: {
        effective: vi.fn(
          () => new Promise<ReturnType<typeof effective>[]>((resolve) => pending.push(resolve)),
        ),
      },
    } as unknown as Client;
    const first = mountWithClient(
      createStore(SessionArtifactsStore, { sessionId: "session-1", model, isActive: () => true }),
      client,
    );
    const second = mountWithClient(
      createStore(SessionArtifactsStore, { sessionId: "session-2", model, isActive: () => true }),
      client,
    );
    pending[0]!([effective("session-1", 1, "One")]);
    pending[1]!([effective("session-2", 1, "One")]);
    await flush();

    expect(model.lineages).toHaveLength(1);
    expect(first.subject.records[0]?.artifact.id).toBe("shared");
    expect(second.subject.records[0]?.artifact.id).toBe("shared");
    expect(model.find("shared")).toBe(model.lineages[0]);
    expect(first.subject.associations[0]?.lineage).toBe(second.subject.associations[0]?.lineage);
    expect(first.subject.associations[0]?.link).toBe(second.subject.associations[0]?.link);
    first.root[Symbol.dispose]();
    second.root[Symbol.dispose]();
  });

  it("surfaces authoritative load failures without replacing current data", async () => {
    const client = {
      artifacts: { effective: vi.fn(async () => Promise.reject(new Error("catalog unavailable"))) },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "session-1",
        model: ArtifactCatalog.create(),
        isActive: () => true,
      }),
      client,
    );
    await flush();

    expect(subject.loading).toBe(false);
    expect(subject.error).toBe("catalog unavailable");
    expect(subject.records).toEqual([]);
    root[Symbol.dispose]();
  });

  it("rejects a stale refresh result", async () => {
    const pending: Array<(value: ReturnType<typeof effective>[]) => void> = [];
    const client = {
      artifacts: {
        effective: vi.fn(
          () => new Promise<ReturnType<typeof effective>[]>((resolve) => pending.push(resolve)),
        ),
      },
    } as unknown as Client;
    const model = ArtifactCatalog.create();
    const { root, subject } = mountWithClient(
      createStore(SessionArtifactsStore, { sessionId: "session-1", model, isActive: () => true }),
      client,
    );
    await flush();
    const second = subject.refresh();
    pending[1]!([effective("session-1", 2, "New")]);
    await second;
    pending[0]!([effective("session-1", 1, "Old")]);
    await flush();

    expect(subject.records[0]?.artifact.title).toBe("New");
    expect(model.find("shared")?.latestRevision).toBe(2);
    root[Symbol.dispose]();
  });
});
