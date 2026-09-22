import type { ArtifactReferenceMetadata } from "../../domain/artifacts/artifact-lineage";

export type ArtifactReferencePreviewState = {
  loading: boolean;
  metadata?: ArtifactReferenceMetadata;
  error?: string;
};
