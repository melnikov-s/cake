import { resolve } from "node:path";
import { Effect } from "effect";
import type { SourceLocation } from "../../ipc/source-location";
import type { UtilityModel } from "../../ipc/session-contract";
import type { CakeModelPresetCatalog } from "../../domain/model-presets/cake-model-selection";
import type { WorktreeLandingCoordinator } from "../../ipc/worktree-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type { ProjectSessionControlInvocation } from "../../domain/project-sessions/project-session-data";
import type { VscodeActionResult } from "../vscode/VsCodeServer";
import {
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";
import type { CakeEvent } from "../../ipc/cake-rpc-contract";
import { compileInlineWidget } from "../widgets/inline-widget-service";
import { publishInlineWidget, revokeInlineWidget } from "../widgets/inline-widget-protocol";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  runInlineWidgetVisualReview,
  type InlineWidgetRevisionRequest,
} from "./runtime/sidecar-runtime";
import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
  WidgetGenerationReviewDependencies,
} from "../../domain/widgets/widgetGenerationReview";
import type { CakeRuntimeOptions } from "./runtime/cake-runtime";
import type { RuntimeUiRequest } from "./runtime/runtime-ui-request";
import type { ImportWorkspaceFileInput } from "../artifacts/importWorkspaceFile";

interface ArtifactRepositoryPort {
  readonly upsert: (
    workingDirectory: string,
    artifact: CakeArtifactV1,
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
}
interface ReviewRepositoryPort {
  readonly reviewContextPath?: (workingDirectory: string, sessionId: string) => string;
}

export type ProjectSessionRuntimeIntegrations = Pick<
  CakeRuntimeOptions,
  | "generateInlineWidget"
  | "reviseInlineWidget"
  | "getArtifact"
  | "listSessionArtifacts"
  | "importArtifactFile"
  | "listArtifacts"
  | "persistArtifact"
  | "requestArtifact"
  | "requestUi"
  | "emitExtensionUiIntent"
  | "reviewContextPath"
> & {
  readonly requestApplicationControl: (
    invocation: ProjectSessionControlInvocation,
    signal: AbortSignal,
  ) => Promise<JsonValue>;
};

/**
 * Cake-owned artifact, UI-request, review, and inline-widget integrations for
 * Pi Session runtimes. Pi runtime lifecycle belongs exclusively to PiSessions.
 */
export interface ProjectSessionIntegrationHostOptions {
  readonly workspacePath: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly resolvedSessionDir?: string;
  readonly widgetSessionDir?: string;
  readonly emit: (event: CakeEvent) => void;
  readonly requestUi: (request: RuntimeUiRequest) => Promise<string | undefined>;
  readonly requestArtifact: (
    record: ArtifactRecord,
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
  readonly runReviewedWidget: (
    input: InlineWidgetGenerationRequest,
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
  ) => Promise<{ readonly pngBase64: string; readonly diagnostics: ReadonlyArray<string> }>;
  readonly requireVisionModel?: (
    model: { provider: string; id: string } | undefined,
  ) => Promise<void>;
  readonly artifactRepository?: ArtifactRepositoryPort;
  readonly importWorkspaceFile?: (input: ImportWorkspaceFileInput) => Promise<CakeArtifactV1>;
  readonly reviewRepository?: ReviewRepositoryPort;
  readonly openExternal?: (url: string) => Promise<void>;
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
  readonly generateSessionTitle?: NonNullable<CakeRuntimeOptions["generateSessionTitle"]>;
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
  private readonly emitEvent: (event: CakeEvent) => void;
  private readonly requestUiFromRenderer: ProjectSessionIntegrationHostOptions["requestUi"];
  private readonly requestArtifactFromRenderer: ProjectSessionIntegrationHostOptions["requestArtifact"];
  private readonly requestApplicationControlFromRenderer: ProjectSessionIntegrationHostOptions["requestApplicationControl"];
  private readonly runWidgetGeneration: typeof runInlineWidgetGeneration;
  private readonly runWidgetRepair: typeof runInlineWidgetRepair;
  private readonly runWidgetVisualReview: typeof runInlineWidgetVisualReview;
  private readonly compileWidget: typeof compileInlineWidget;
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
    this.emitEvent = options.emit;
    this.requestUiFromRenderer = options.requestUi;
    this.requestArtifactFromRenderer = options.requestArtifact;
    this.requestApplicationControlFromRenderer = options.requestApplicationControl;
    this.runWidgetGeneration = options.runWidgetGeneration ?? runInlineWidgetGeneration;
    this.runWidgetRepair = options.runWidgetRepair ?? runInlineWidgetRepair;
    this.runWidgetVisualReview = options.runWidgetVisualReview ?? runInlineWidgetVisualReview;
    this.compileWidget = options.compileWidget ?? compileInlineWidget;
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
      persistArtifact: (artifact) => this.execute(this.persistArtifact(artifact, sessionId)),
      requestArtifact: (record, signal) => this.requestArtifactFromRenderer(record, signal),
      generateInlineWidget: (input) => this.execute(this.generateInlineWidget(input), input.signal),
      reviseInlineWidget: (input) => this.execute(this.reviseInlineWidget(input), input.signal),
      getArtifact: (artifactId) =>
        this.execute(this.artifactRepository.get(this.workspacePath, sessionId, artifactId)),
      listSessionArtifacts: () =>
        this.execute(this.artifactRepository.listSession(this.workspacePath, sessionId)),
      importArtifactFile: (input) =>
        this.importWorkspaceFile({
          ...input,
          workingDirectory: this.workspacePath,
          sessionId,
        }),
      reviewContextPath: reviewContextPath
        ? (activeSessionId) => reviewContextPath(this.workspacePath, activeSessionId)
        : undefined,
      listArtifacts: (pointers) => {
        const repository = this.artifactRepository;
        const workingDirectory = this.workspacePath;
        return this.execute(
          Effect.gen(function* () {
            const direct = yield* Effect.forEach(pointers, (pointer) =>
              repository.get(workingDirectory, pointer.sessionId, pointer.artifactId),
            );
            const indexed = yield* repository.listSession(workingDirectory, sessionId);
            const records = new Map<string, ArtifactRecord>();
            for (const record of [...direct, ...indexed]) {
              if (!record) continue;
              const current = records.get(record.artifact.id);
              if (!current || record.artifact.revision > current.artifact.revision)
                records.set(record.artifact.id, record);
            }
            return [...records.values()];
          }),
        );
      },
    };
  }

  private emit(event: CakeEvent) {
    if (!this.disposed) this.emitEvent(event);
  }

  private persistArtifact(artifact: CakeArtifactV1, activeSessionId: string) {
    const repository = this.artifactRepository;
    const workingDirectory = this.workspacePath;
    const emit = (event: CakeEvent) => this.emit(event);
    return Effect.gen(function* () {
      const persistedArtifact =
        artifact.kind === "request"
          ? {
              ...artifact,
              revision:
                ((yield* repository.get(workingDirectory, artifact.sessionId, artifact.id))
                  ?.artifact.revision ?? 0) + 1,
            }
          : artifact;
      const record = yield* repository.upsert(workingDirectory, persistedArtifact);
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
      fallback: input.fallback,
    });
    return this.reviewWidget(input, context, () =>
      this.runWidgetGeneration({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        sessionDir: this.widgetSessionDir,
        ...input,
      }),
    );
  }

  private reviseInlineWidget(input: InlineWidgetRevisionRequest) {
    const context = JSON.stringify({
      brief: input.brief,
      fallback: input.fallback,
      revisionInstructions: input.instructions,
    });
    const generationInput: InlineWidgetGenerationRequest = {
      sessionId: input.sessionId,
      brief: input.brief,
      fallback: input.fallback,
      model: input.model,
      signal: input.signal,
    };
    return this.reviewWidget(generationInput, context, () =>
      this.runWidgetRepair({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        sessionDir: this.widgetSessionDir,
        language: "react",
        capability: "display",
        source: input.source,
        context,
        diagnostic: `Requested durable revision: ${input.instructions}`,
        model: input.model,
        signal: input.signal,
      }),
    );
  }

  private reviewWidget(
    input: InlineWidgetGenerationRequest,
    context: string,
    generate: () => ReturnType<typeof runInlineWidgetGeneration>,
  ) {
    const fromPromise = <A>(evaluate: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: evaluate, catch: (cause) => cause });
    return this.runReviewedWidget(input, {
      requireVisionModel: (model) => fromPromise(() => this.requireVisionModel(model)),
      generate: () => fromPromise(() => generate()),
      compile: (source) =>
        fromPromise(() => this.compileWidget("react", source, "display")).pipe(
          Effect.map((compiled) => {
            const widget = publishInlineWidget(compiled);
            return {
              widget,
              release: Effect.sync(() => revokeInlineWidget(widget.token)),
            };
          }),
        ),
      repair: (source, diagnostic) =>
        fromPromise(() =>
          this.runWidgetRepair({
            cwd: this.workspacePath,
            agentDir: this.agentDir,
            sessionDir: this.widgetSessionDir,
            language: "react",
            capability: "display",
            source,
            context,
            diagnostic,
            model: input.model,
            signal: input.signal,
          }),
        ),
      capture: (widget) =>
        fromPromise((signal) => this.captureWidget(input.sessionId, widget, signal)),
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
            source,
            context,
            diagnostic,
            pngBase64,
            model,
            signal: input.signal,
          }),
        );
      },
    });
  }
}
