import { Schema } from "effect";
import {
  ArtifactRevision,
  type ArtifactLineageDetail,
} from "../../../src/contracts/artifacts/artifact-lineage";

export function widgetInstance(id = "widget-fixture") {
  const revision = Schema.decodeUnknownSync(ArtifactRevision)({
    lineageId: id,
    metadata: {
      revision: 1,
      digest: "a".repeat(64),
      kind: "widget",
      title: "Fixture widget",
      publishedAt: "2026-01-01T00:00:00Z",
      publishedBySessionId: "owner",
      workingDirectory: "/project",
    },
    snapshot: {
      protocol: "cake.artifact/v1",
      id,
      sessionId: "owner",
      revision: 1,
      kind: "widget",
      title: "Fixture widget",
      payload: {
        language: "html",
        source: "<p>Fixture widget</p>",
        brief: "Fixture",
        browser: { digest: "b".repeat(64) },
      },
      fallback: { markdown: "Fixture widget fallback" },
    },
  });
  const detail: ArtifactLineageDetail = {
    lineage: {
      id: revision.lineageId,
      global: false,
      createdAt: revision.metadata.publishedAt,
      latestRevision: revision.metadata.revision,
      latest: revision.metadata,
      title: "Fixture widget",
      stableRef: `cake://artifact/${id}`,
    },
    links: [],
    stableRef: `cake://artifact/${id}`,
  };
  return { revision, detail };
}
