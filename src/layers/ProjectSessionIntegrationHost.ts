import type { InterviewRecord } from "../contracts/interviews/interview";
import { resolve } from "node:path";
import { Effect } from "effect";
import type { SourceLocation } from "../contracts/editor/source-location";
import type { UtilityModel } from "../contracts/conversations/session-contract";
import type { CakeModelPresetCatalog } from "../contracts/model-presets/cake-model-selection";
import type { WorktreeLandingCoordinator } from "../contracts/worktrees/worktree-contract";
import type { JsonValue } from "../contracts/serialization/json-contract";
import type { WidgetCandidate } from "../contracts/widgets/widget-candidate";
import type { WidgetBrowserOutput } from "../contracts/widgets/widget-browser-output";
import type { CompiledInlineWidgetDocument } from "../services/widgets/inline-widget-service";
import type { ProjectSessionControlInvocation } from "../contracts/project-sessions/project-session-data";
import type { VscodeActionResult } from "../contracts/vscode/vscode-action-result";
import {
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../contracts/artifacts/artifact-contract";
import type { CakeEvent } from "../contracts/application/cake-rpc-contract";
import { compileInlineWidget } from "../services/widgets/inline-widget-service";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../services/widgets/inline-widget-document-registry";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  runInlineWidgetVisualReview,
} from "../services/pi/runtime/sidecar-runtime";
import {
  type InlineWidgetRevisionRequest,
  type InlineWidgetGenerationRequest,
} from "../contracts/widgets/widget-generation";
import type {
  InlineWidgetGenerationRequest as WidgetReviewInput,
  InlineWidgetGenerationResult,
  WidgetGenerationReviewDependencies,
} from "../domain/widgets/widgetGenerationReview";
import type { CakeSessionRuntimeOptions } from "../services/pi/runtime/cake-session-runtime";
import type { RuntimeUiRequest } from "../services/pi/runtime/runtime-ui-request";
import type { ImportWorkspaceFileInput } from "../services/artifacts/importWorkspaceFile";
import type { ArtifactProjectionMetadata } from "../contracts/artifacts/artifact-projection-data";
import type { ResolvedAgentArtifact } from "../contracts/artifacts/artifact-agent-control";

import type {
  ArtifactState,
  ArtifactStateReplacement,
  ArtifactStateUpdate,
  ArtifactStagedState,
} from "../contracts/artifacts/artifact-state";

interface ArtifactRepositoryPort {
  readonly readState: (
    sessionId: string,
    lineageId: string,
  ) => Effect.Effect<ArtifactState, unknown, never>;
  readonly replaceState: (
    sessionId: string,
    input: ArtifactStateReplacement,
  ) => Effect.Effect<ArtifactState, unknown, never>;
  readonly updateState: (
    sessionId: string,
    input: ArtifactStateUpdate,
  ) => Effect.Effect<ArtifactState, unknown, never>;
  readonly upsert: (
    workingDirectory: string,
    artifact: CakeArtifactV1,
    stagedState?: ArtifactStagedState,
  ) => Effect.Effect<ArtifactRecord, unknown, never>;
  readonly get: (
    workingDirectory: string,
    sessionId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | undefined, unknown, never>;
  readonly listSession: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactRecord>, unknown, never>;
  readonly linkSession: (
    record: ArtifactRecord,
    sessionId: string,
  ) => Effect.Effect<void, unknown, never>;
  readonly resolve: (
    sessionId: string,
    reference: string,
  ) => Effect.Effect<ResolvedAgentArtifact, unknown, never>;
  readonly hasAnyLinked: (sessionId: string) => Effect.Effect<boolean, unknown, never>;
  readonly listMetadata: (
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactProjectionMetadata>, unknown, never>;
  readonly history: (
    sessionId: string,
    reference: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactProjectionMetadata>, unknown, never>;
  readonly restore: (
    workingDirectory: string,
    sessionId: string,
    input: {
      readonly lineageId: string;
      readonly sourceRevision: number;
      readonly expectedRevision: number;
    },
  ) => Effect.Effect<ResolvedAgentArtifact, unknown, never>;
  readonly link: (
    sessionId: string,
    reference: string,
  ) => Effect.Effect<ArtifactProjectionMetadata, unknown, never>;
  readonly unlink: (sessionId: string, lineageId: string) => Effect.Effect<void, unknown, never>;
}
interface ReviewRepositoryPort {
  readonly reviewContextPath?: (workingDirectory: string, sessionId: string) => string;
}

import type { ProjectSessionRuntimeIntegrations } from "../services/pi/ProjectSessionRuntimeHost";

/**
 * Cake-owned artifact, UI-request, review, and inline-widget integrations for
 * Pi Session runtimes. Pi runtime lifecycle belongs exclusively to CakeSessionRuntimes.
 */
export interface ProjectSessionIntegrationHostOptions {
  readonly workspacePath: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly resolvedSessionDir?: string;
  readonly widgetSessionDir?: string;
  readonly emit: (event: CakeEvent) => void;
  readonly requestUi: (request: RuntimeUiRequest) => Promise<string | undefined>;
  readonly requestInterview: (
    record: InterviewRecord,
    signal: AbortSignal,
  ) => Promise<JsonValue | undefined>;
  readonly requestApplicationControl: (
    invocation: ProjectSessionControlInvocation,
    signal: AbortSignal,
  ) => Promise<JsonValue>;
  readonly runWidgetGeneration?: typeof runInlineWidgetGeneration;
  readonly runWidgetRepair?: typeof runInlineWidgetRepair;
  readonly runWidgetVisualReview?: typeof runInlineWidgetVisualReview;
  readonly compileWidget?: typeof compileInlineWidget;
  readonly retainWidgetBrowser?: (
    compiled: CompiledInlineWidgetDocument,
  ) => Promise<WidgetBrowserOutput>;
  readonly runReviewedWidget: (
    input: WidgetReviewInput,
    dependencies: WidgetGenerationReviewDependencies,
  ) => Effect.Effect<InlineWidgetGenerationResult, unknown, never>;
  /** Final Pi callback adapter. This is the only place this host executes Effects. */
  readonly execute: <A>(
    effect: Effect.Effect<A, unknown, never>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly captureWidget?: (
    sessionId: string,
    widget: { readonly token: string; readonly url: string },
    signal: AbortSignal,
    pluginState?: JsonValue,
  ) => Promise<{ readonly pngBase64: string; readonly diagnostics: ReadonlyArray<string> }>;
  readonly requireVisionModel?: (
    model: { provider: string; id: string } | undefined,
  ) => Promise<void>;
  readonly artifactRepository?: ArtifactRepositoryPort;
  readonly importWorkspaceFile?: (input: ImportWorkspaceFileInput) => Promise<CakeArtifactV1>;
  readonly reviewRepository?: ReviewRepositoryPort;
  readonly enterEditor?: (signal: AbortSignal) => Promise<void>;
  readonly openInEditor?: (
    location: SourceLocation,
    signal: AbortSignal,
  ) => Promise<VscodeActionResult<SourceLocation>>;
  readonly runEditorScript?: (
    source: string,
    input: JsonValue,
    signal: AbortSignal,
  ) => Promise<VscodeActionResult<JsonValue>>;
  readonly isTrusted?: () => boolean;
  readonly utilityModel?: () => UtilityModel | undefined;
  readonly generateSessionTitle?: NonNullable<CakeSessionRuntimeOptions["generateSessionTitle"]>;
  readonly modelPresets?: () => CakeModelPresetCatalog;
  readonly worktreeLanding?: WorktreeLandingCoordinator;
  readonly fastMode?: (sessionId: string) => boolean;
  readonly setFastMode?: (sessionId: string, enabled: boolean) => Promise<void>;
  readonly sessionResolved?: (sessionId: string) => boolean;
  readonly setSessionResolved?: (sessionId: string, resolved: boolean) => Promise<void>;
  readonly sessionTitleChanged?: (sessionId: string, title: string) => Promise<void>;
}

export class ProjectSessionIntegrationHost {
  readonly workspacePath: string;
  private readonly agentDir: string;
  private readonly widgetSessionDir: string;
  private readonly widgetSessionRoots: ReadonlyArray<string>;
  private readonly emitEvent: (event: CakeEvent) => void;
  private readonly requestUiFromRenderer: ProjectSessionIntegrationHostOptions["requestUi"];
  private readonly requestInterviewFromRenderer: ProjectSessionIntegrationHostOptions["requestInterview"];
  private readonly requestApplicationControlFromRenderer: ProjectSessionIntegrationHostOptions["requestApplicationControl"];
  private readonly runWidgetGeneration: typeof runInlineWidgetGeneration;
  private readonly runWidgetRepair: typeof runInlineWidgetRepair;
  private readonly runWidgetVisualReview: typeof runInlineWidgetVisualReview;
  private readonly compileWidget: typeof compileInlineWidget;
  private readonly retainWidgetBrowser: NonNullable<
    ProjectSessionIntegrationHostOptions["retainWidgetBrowser"]
  >;
  private readonly isTrusted: () => boolean;
  private readonly runReviewedWidget: ProjectSessionIntegrationHostOptions["runReviewedWidget"];
  private readonly execute: ProjectSessionIntegrationHostOptions["execute"];
  private readonly captureWidget: NonNullable<
    ProjectSessionIntegrationHostOptions["captureWidget"]
  >;
  private readonly requireVisionModel: NonNullable<
    ProjectSessionIntegrationHostOptions["requireVisionModel"]
  >;
  private readonly artifactRepository: ArtifactRepositoryPort;
  private readonly importWorkspaceFile: NonNullable<
    ProjectSessionIntegrationHostOptions["importWorkspaceFile"]
  >;
  private readonly reviewRepository: ReviewRepositoryPort;
  private disposed = false;

  constructor(options: ProjectSessionIntegrationHostOptions) {
    this.workspacePath = options.workspacePath;
    this.agentDir = options.agentDir;
    this.widgetSessionDir =
      options.widgetSessionDir ?? resolve(options.sessionDir, "..", "widget-sessions");
    this.widgetSessionRoots = [options.sessionDir, this.widgetSessionDir];
    this.emitEvent = options.emit;
    this.requestUiFromRenderer = options.requestUi;
    this.requestInterviewFromRenderer = options.requestInterview;
    this.requestApplicationControlFromRenderer = options.requestApplicationControl;
    this.runWidgetGeneration = options.runWidgetGeneration ?? runInlineWidgetGeneration;
    this.runWidgetRepair = options.runWidgetRepair ?? runInlineWidgetRepair;
    this.runWidgetVisualReview = options.runWidgetVisualReview ?? runInlineWidgetVisualReview;
    this.compileWidget = options.compileWidget ?? compileInlineWidget;
    this.isTrusted = options.isTrusted ?? (() => false);
    this.retainWidgetBrowser =
      options.retainWidgetBrowser ??
      (async () => {
        throw new Error("Durable widget browser output retention is unavailable");
      });
    this.runReviewedWidget = options.runReviewedWidget;
    this.execute = options.execute;
    this.captureWidget =
      options.captureWidget ??
      (async () => {
        throw new Error(
          "Rendered widget review is unavailable because no Cake renderer capture service is configured",
        );
      });
    this.requireVisionModel =
      options.requireVisionModel ??
      (async (model) => {
        if (!model)
          throw new Error("Rendered widget review requires a configured vision-capable model");
      });
    this.importWorkspaceFile =
      options.importWorkspaceFile ??
      (async () => {
        throw new Error("Workspace file artifact import is unavailable");
      });
    this.artifactRepository = options.artifactRepository ?? {
      readState: () => Effect.die(new Error("Artifact state is unavailable")),
      replaceState: () => Effect.die(new Error("Artifact state is unavailable")),
      updateState: () => Effect.die(new Error("Artifact state is unavailable")),
      upsert: (workingDirectory, artifact) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            artifact: parseArtifactInput(artifact),
            workspacePath: workingDirectory,
            digest: "0".repeat(64),
            createdAt: now,
            updatedAt: now,
          };
        }),
      get: () => Effect.succeed(undefined),
      listSession: () => Effect.succeed([]),
      linkSession: () => Effect.void,
      resolve: () => Effect.die(new Error("Artifact resolution is unavailable")),
      hasAnyLinked: () => Effect.succeed(false),
      listMetadata: () => Effect.succeed([]),
      history: () => Effect.die(new Error("Artifact history is unavailable")),
      restore: () => Effect.die(new Error("Artifact restore is unavailable")),
      link: () => Effect.die(new Error("Artifact linking is unavailable")),
      unlink: () => Effect.die(new Error("Artifact unlinking is unavailable")),
    };
    this.reviewRepository = options.reviewRepository ?? {};
  }

  [Symbol.dispose]() {
    this.disposed = true;
  }

  runtimeIntegrations(sessionId: string): ProjectSessionRuntimeIntegrations {
    const reviewContextPath = this.reviewRepository.reviewContextPath;
    return {
      requestUi: (request) => this.requestUiFromRenderer(request),
      requestApplicationControl: (invocation, signal) =>
        this.requestApplicationControlFromRenderer(invocation, signal),
      emitExtensionUiIntent: (intent) =>
        this.emit({ type: "extension-ui-intent", sessionId, intent }),
      persistArtifact: (artifact, stagedState) =>
        this.execute(this.persistArtifact(artifact, sessionId, stagedState)),
      compileArtifactBrowser: async (language, source) =>
        this.retainWidgetBrowser(await this.compileWidget(language, source, "artifact")),
      requestInterview: (record, signal) => this.requestInterviewFromRenderer(record, signal),
      generateInlineWidget: (input) => this.execute(this.generateInlineWidget(input), input.signal),
      reviseInlineWidget: (input) => this.execute(this.reviseInlineWidget(input), input.signal),
      readArtifactState: (lineageId) =>
        this.execute(this.artifactRepository.readState(sessionId, lineageId)),
      replaceArtifactState: (input) =>
        this.execute(this.artifactRepository.replaceState(sessionId, input)),
      updateArtifactState: (input) =>
        this.execute(this.artifactRepository.updateState(sessionId, input)),
      resolveArtifact: (reference) =>
        this.execute(this.artifactRepository.resolve(sessionId, reference)),
      hasLinkedArtifacts: () => this.execute(this.artifactRepository.hasAnyLinked(sessionId)),
      listArtifactMetadata: () => this.execute(this.artifactRepository.listMetadata(sessionId)),
      historyArtifact: (reference) =>
        this.execute(this.artifactRepository.history(sessionId, reference)),
      restoreArtifact: (input) =>
        this.execute(this.artifactRepository.restore(this.workspacePath, sessionId, input)),
      linkArtifact: (reference) => this.execute(this.artifactRepository.link(sessionId, reference)),
      unlinkArtifact: (lineageId) =>
        this.execute(this.artifactRepository.unlink(sessionId, lineageId)),
      importArtifactFile: (input) =>
        this.importWorkspaceFile({
          ...input,
          workingDirectory: this.workspacePath,
          sessionId,
        }),
      reviewContextPath: reviewContextPath
        ? (activeSessionId) => reviewContextPath(this.workspacePath, activeSessionId)
        : undefined,
    };
  }

  private emit(event: CakeEvent) {
    if (!this.disposed) this.emitEvent(event);
  }

  private persistArtifact(
    artifact: CakeArtifactV1,
    activeSessionId: string,
    stagedState?: ArtifactStagedState,
  ) {
    const repository = this.artifactRepository;
    const workingDirectory = this.workspacePath;
    const emit = (event: CakeEvent) => this.emit(event);
    return Effect.gen(function* () {
      const record = yield* repository.upsert(workingDirectory, artifact, stagedState);
      if (activeSessionId !== artifact.sessionId)
        yield* repository.linkSession(record, activeSessionId);
      emit({ type: "artifact-updated", record });
      return record;
    });
  }

  private generateInlineWidget(input: InlineWidgetGenerationRequest) {
    const context = JSON.stringify({
      brief: input.brief,
      data: input.data,
      initialState: input.initialState,
      fallback: input.fallback,
      surface: input.surface ?? "widget",
    });
    const candidate: WidgetCandidate = { source: "", state: input.initialState ?? null };
    return this.reviewWidget(input, context, candidate, () =>
      this.runWidgetGeneration({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        sessionDir: this.widgetSessionDir,
        sessionRoots: this.widgetSessionRoots,
        conversation: { type: "parent", origin: input.parentConversation },
        candidate: input.surface === "session-plugin" ? undefined : candidate,
        projectTrusted: this.isTrusted(),
        ...input,
      }),
    );
  }

  private reviseInlineWidget(input: InlineWidgetRevisionRequest) {
    const context = JSON.stringify({
      brief: input.brief,
      fallback: input.fallback,
      revisionInstructions: input.instructions,
      initialState: input.initialState ?? null,
    });
    const generationInput: WidgetReviewInput = {
      sessionId: input.sessionId,
      brief: input.brief,
      fallback: input.fallback,
      initialState: input.initialStateVersion === 0 ? undefined : input.initialState,
      model: input.model,
      signal: input.signal,
    };
    const candidate: WidgetCandidate = { source: input.source, state: input.initialState ?? null };
    return this.reviewWidget(generationInput, context, candidate, () =>
      this.runWidgetRepair({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        sessionDir: this.widgetSessionDir,
        sessionRoots: this.widgetSessionRoots,
        conversation: { type: "revision", sessionId: input.generationSessionId },
        language: "react",
        capability: "artifact",
        source: input.source,
        candidate,
        projectTrusted: this.isTrusted(),
        context,
        diagnostic: `Requested durable revision: ${input.instructions}`,
        model: input.model,
        signal: input.signal,
      }),
    );
  }

  private reviewWidget(
    input: WidgetReviewInput,
    context: string,
    candidate: WidgetCandidate,
    generate: () => ReturnType<typeof runInlineWidgetGeneration>,
  ) {
    let generationSessionId: string | undefined;
    const conversation = () => {
      if (!generationSessionId) throw new Error("Widget generation has not started");
      return { type: "continue" as const, sessionId: generationSessionId };
    };
    const fromPromise = <A>(evaluate: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: evaluate, catch: (cause) => cause });
    const originalState = JSON.stringify(candidate.state);
    return this.runReviewedWidget(input, {
      requireVisionModel: (model) => fromPromise(() => this.requireVisionModel(model)),
      generate: () =>
        fromPromise(async () => {
          const generated = await generate();
          generationSessionId = generated.sessionId;
          return generated;
        }),
      compile: (source) =>
        fromPromise(() => {
          candidate.source = source;
          return this.compileWidget(
            "react",
            source,
            input.surface === "session-plugin" ? "session-plugin" : "artifact",
          );
        }).pipe(
          Effect.map((compiled) => {
            const widget = publishInlineWidget(compiled);
            return {
              widget,
              release: Effect.sync(() => revokeInlineWidget(widget.token)),
              retain: () => fromPromise(() => this.retainWidgetBrowser(compiled)),
            };
          }),
        ),
      repair: (source, diagnostic) =>
        fromPromise(() =>
          this.runWidgetRepair({
            cwd: this.workspacePath,
            agentDir: this.agentDir,
            sessionDir: this.widgetSessionDir,
            sessionRoots: this.widgetSessionRoots,
            conversation: conversation(),
            language: "react",
            capability: input.surface === "session-plugin" ? "session-plugin" : "artifact",
            source,
            candidate: input.surface === "session-plugin" ? undefined : candidate,
            projectTrusted: this.isTrusted(),
            context,
            diagnostic,
            model: input.model,
            signal: input.signal,
          }),
        ),
      capture: (widget) =>
        fromPromise((signal) =>
          this.captureWidget(
            input.sessionId,
            widget,
            signal,
            input.surface === "session-plugin"
              ? (input.initialState ?? null)
              : input.initialState === undefined && candidate.state === null
                ? undefined
                : candidate.state,
          ),
        ),
      review: (source, diagnostic, pngBase64) => {
        const model = input.model;
        if (!model)
          return Effect.fail(
            new Error("Rendered widget review requires a configured vision-capable model"),
          );
        return fromPromise(() =>
          this.runWidgetVisualReview({
            cwd: this.workspacePath,
            agentDir: this.agentDir,
            sessionDir: this.widgetSessionDir,
            sessionRoots: this.widgetSessionRoots,
            conversation: conversation(),
            source,
            context:
              input.surface === "session-plugin"
                ? context
                : `${context}\n\nCurrent staged artifact state (authoritative for this preview):\n${JSON.stringify(candidate.state)}`,
            diagnostic,
            pngBase64,
            model,
            signal: input.signal,
          }),
        );
      },
    }).pipe(
      Effect.map((accepted) => ({
        ...accepted,
        ...(originalState === JSON.stringify(candidate.state) ? null : { state: candidate.state }),
      })),
    );
  }
}
