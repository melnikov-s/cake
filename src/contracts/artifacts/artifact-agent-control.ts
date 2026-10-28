import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
  InlineWidgetRevisionRequest,
} from "../widgets/widget-generation";

import type { WidgetBrowserOutput } from "../widgets/widget-browser-output";
import type { WidgetPreview } from "../widgets/widget-preview";
import type { JsonValue } from "../serialization/json-contract";

import type {
  ArtifactStagedState,
  ArtifactState,
  ArtifactStateReplacement,
  ArtifactStateUpdate,
} from "./artifact-state";
import type { ArtifactRecord, CakeArtifactV1 } from "./artifact-contract";
import type { ArtifactProjectionMetadata } from "./artifact-projection-data";

export interface ResolvedAgentArtifact {
  readonly record: ArtifactRecord;
  readonly metadata: ArtifactProjectionMetadata;
}

export interface CakeArtifactOperationOptions {
  readArtifactState?(lineageId: string): Promise<ArtifactState>;
  replaceArtifactState?(input: ArtifactStateReplacement): Promise<ArtifactState>;
  updateArtifactState?(input: ArtifactStateUpdate): Promise<ArtifactState>;
  persistArtifact(
    artifact: CakeArtifactV1,
    stagedState?: ArtifactStagedState,
  ): Promise<ArtifactRecord>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
  reviseInlineWidget?(input: InlineWidgetRevisionRequest): Promise<InlineWidgetGenerationResult>;
  captureWidgetInstance?(input: {
    sessionId: string;
    browser: WidgetBrowserOutput;
    initialState: JsonValue;
    signal: AbortSignal;
  }): Promise<WidgetPreview>;
  resolveArtifact?(reference: string): Promise<ResolvedAgentArtifact>;
  /** Permanent chats may establish an effective link when explicitly presenting a reference. */
  resolveArtifactForPresentation?(reference: string): Promise<ResolvedAgentArtifact>;
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
