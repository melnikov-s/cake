import type { ArtifactProjectionMetadata } from "../../src/contracts/artifacts/artifact-projection-data";
import type { CakeArtifactOperationOptions } from "../../src/contracts/artifacts/artifact-agent-control";

export function artifactMetadata(id = "design-plan"): ArtifactProjectionMetadata {
  return {
    lineageId: id,
    title: "Design plan",
    kind: "markdown",
    selectedRevision: 2,
    latestRevision: 3,
    digest: "a".repeat(64),
    linkMode: "pinned",
    stableRef: `cake://artifact/${id}`,
    exactRef: `cake://artifact/${id}@r2`,
    exactPath: `/cache/${id}/r2`,
    files: [
      {
        name: "content.md",
        path: `/cache/${id}/r2/content.md`,
        byteSize: 4,
        sha256: "b".repeat(64),
      },
    ],
  };
}

/** Only the authoritative artifact service boundary is replaced. */
export function artifactOperationOptions(
  listArtifactMetadata: NonNullable<
    CakeArtifactOperationOptions["listArtifactMetadata"]
  > = async () => [artifactMetadata()],
): CakeArtifactOperationOptions {
  return {
    listArtifactMetadata,
    async historyArtifact() {
      return [artifactMetadata()];
    },
    async resolveArtifact(reference) {
      if (reference.includes("missing")) throw new Error("Artifact is not linked");
      return {
        metadata: artifactMetadata(),
        record: {
          artifact: {
            protocol: "cake.artifact/v1",
            id: "design-plan",
            sessionId: "fixture-session",
            revision: 2,
            kind: "markdown",
            payload: { markdown: "Content never returned by metadata operations" },
            fallback: { markdown: "Content never returned by metadata operations" },
            interaction: { mode: "present" },
          },
          workspacePath: "/workspace",
          digest: "a".repeat(64),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    },
    async persistArtifact() {
      throw new Error("Unexpected write in read-only fixture");
    },
  };
}
