import type { ArtifactReferenceMetadata } from "../../services/storage/artifact-lineage";

export type ArtifactReferencePreviewState = {
  loading: boolean;
  metadata?: ArtifactReferenceMetadata;
  error?: string;
};
