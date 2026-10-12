import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
  InlineWidgetRevisionRequest,
} from "../widgets/widget-generation";

import type { ArtifactRecord, CakeArtifactV1 } from "./artifact-contract";
import type { ArtifactProjectionMetadata } from "./artifact-projection-data";

export interface ResolvedAgentArtifact {
  readonly record: ArtifactRecord;
  readonly metadata: ArtifactProjectionMetadata;
}

export interface CakeArtifactOperationOptions {
  persistArtifact(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
  reviseInlineWidget?(input: InlineWidgetRevisionRequest): Promise<InlineWidgetGenerationResult>;
  resolveArtifact?(reference: string): Promise<ResolvedAgentArtifact>;
  hasLinkedArtifacts?(): Promise<boolean>;
  listArtifactMetadata?(): Promise<ReadonlyArray<ArtifactProjectionMetadata>>;
  historyArtifact?(reference: string): Promise<ReadonlyArray<ArtifactProjectionMetadata>>;
  restoreArtifact?(input: {
    lineageId: string;
    sourceRevision: number;
    expectedRevision: number;
  }): Promise<ResolvedAgentArtifact>;
  linkArtifact?(reference: string): Promise<ArtifactProjectionMetadata>;
  unlinkArtifact?(lineageId: string): Promise<void>;
  importArtifactFile?(input: ArtifactFileImportInput): Promise<CakeArtifactV1>;
}

interface ArtifactFileImportInput {
  path: string;
  id: string;
  revision: number;
  title?: string;
}
