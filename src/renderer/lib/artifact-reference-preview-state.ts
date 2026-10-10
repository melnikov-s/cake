import type { ArtifactReferenceMetadata } from "../../contracts/artifacts/artifact-lineage";

export type ArtifactReferencePreviewState = {
  loading: boolean;
  metadata?: ArtifactReferenceMetadata;
  error?: string;
};
