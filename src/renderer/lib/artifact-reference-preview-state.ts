import type { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";

export type ArtifactReferencePreviewState = {
  loading: boolean;
  exactRef?: ArtifactStableRef;
  error?: string;
};
