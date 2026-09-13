import { resolve } from "node:path";
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
import { compileInlineWidget, extractRepairedWidget } from "../widgets/inline-widget-service";
import { publishInlineWidget, revokeInlineWidget } from "../widgets/inline-widget-protocol";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  runInlineWidgetVisualReview,
  type InlineWidgetGenerationRequest,
} from "./runtime/sidecar-runtime";
import type { CakeRuntimeOptions } from "./runtime/cake-runtime";
import type { RuntimeUiRequest } from "./runtime/runtime-ui-request";

interface ArtifactRepositoryPort {
  readonly upsert: (workingDirectory: string, artifact: CakeArtifactV1) => Promise<ArtifactRecord>;
  readonly get: (
    workingDirectory: string,
    sessionId: string,
    artifactId: string,
  ) => Promise<ArtifactRecord | undefined>;
  readonly listSession: (
    workingDirectory: string,
    sessionId: string,
  ) => Promise<ReadonlyArray<ArtifactRecord>>;
  readonly linkSession: (record: ArtifactRecord, sessionId: string) => Promise<void>;
}
interface ReviewRepositoryPort {
  readonly reviewContextPath?: (workingDirectory: string, sessionId: string) => string;
}

export type ProjectSessionRuntimeIntegrations = Pick<
  CakeRuntimeOptions,
  | "generateInlineWidget"
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
  readonly captureWidget?: (
    sessionId: string,
    widget: { readonly token: string; readonly url: string },
    signal: AbortSignal,
  ) => Promise<{ readonly pngBase64: string; readonly diagnostics: ReadonlyArray<string> }>;
  readonly requireVisionModel?: (
    model: { provider: string; id: string } | undefined,
  ) => Promise<void>;
  readonly artifactRepository?: ArtifactRepositoryPort;
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
  private readonly captureWidget: NonNullable<
    ProjectSessionIntegrationHostOptions["captureWidget"]
  >;
  private readonly requireVisionModel: NonNullable<
    ProjectSessionIntegrationHostOptions["requireVisionModel"]
  >;
  private readonly artifactRepository: ArtifactRepositoryPort;
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
    this.artifactRepository = options.artifactRepository ?? {
      async upsert(workingDirectory, artifact) {
        const now = new Date().toISOString();
        return {
          artifact: parseArtifactInput(artifact),
          workspacePath: workingDirectory,
          digest: "0".repeat(64),
          createdAt: now,
          updatedAt: now,
        };
      },
      async get() {
        return undefined;
      },
      async listSession() {
        return [];
      },
      async linkSession() {},
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
      persistArtifact: (artifact) => this.persistArtifact(artifact, sessionId),
      requestArtifact: (record, signal) => this.requestArtifactFromRenderer(record, signal),
      generateInlineWidget: (input) => this.generateInlineWidget(input),
      reviewContextPath: reviewContextPath
        ? (activeSessionId) => reviewContextPath(this.workspacePath, activeSessionId)
        : undefined,
      listArtifacts: async (pointers) => {
        const direct = await Promise.all(
          pointers.map((pointer) =>
            this.artifactRepository.get(this.workspacePath, pointer.sessionId, pointer.artifactId),
          ),
        );
        const indexed = await this.artifactRepository.listSession(this.workspacePath, sessionId);
        const records = new Map<string, ArtifactRecord>();
        for (const record of [...direct, ...indexed]) {
          if (!record) continue;
          const current = records.get(record.artifact.id);
          if (!current || record.artifact.revision > current.artifact.revision)
            records.set(record.artifact.id, record);
        }
        return [...records.values()];
      },
    };
  }

  private emit(event: CakeEvent) {
    if (!this.disposed) this.emitEvent(event);
  }

  private async persistArtifact(artifact: CakeArtifactV1, activeSessionId: string) {
    const persistedArtifact =
      artifact.kind === "request"
        ? {
            ...artifact,
            revision:
              ((
                await this.artifactRepository.get(
                  this.workspacePath,
                  artifact.sessionId,
                  artifact.id,
                )
              )?.artifact.revision ?? 0) + 1,
          }
        : artifact;
    const record = await this.artifactRepository.upsert(this.workspacePath, persistedArtifact);
    if (activeSessionId !== artifact.sessionId)
      await this.artifactRepository.linkSession(record, activeSessionId);
    this.emit({ type: "artifact-updated", record });
    return record;
  }

  private async generateInlineWidget(input: InlineWidgetGenerationRequest) {
    await this.requireVisionModel(input.model);
    if (!input.model)
      throw new Error("Rendered widget review requires a configured vision-capable model");
    const generated = await this.runWidgetGeneration({
      cwd: this.workspacePath,
      agentDir: this.agentDir,
      sessionDir: this.widgetSessionDir,
      ...input,
    });
    const language = "react" as const;
    const context = JSON.stringify({
      brief: input.brief,
      data: input.data,
      fallback: input.fallback,
    });
    let source = extractRepairedWidget(generated.response, language);
    let replacements = 0;
    let diagnostic = "Compilation succeeded.";

    while (true) {
      if (input.signal?.aborted) throw new Error("Widget generation was cancelled");
      let compiled: Awaited<ReturnType<typeof compileInlineWidget>>;
      try {
        compiled = await this.compileWidget(language, source, "display");
      } catch (error) {
        diagnostic =
          `Compilation failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            8_000,
          );
        if (replacements >= 2)
          throw new Error(`Widget review exhausted its two replacements. ${diagnostic}`);
        const repaired = await this.runWidgetRepair({
          cwd: this.workspacePath,
          agentDir: this.agentDir,
          sessionDir: this.widgetSessionDir,
          language,
          capability: "display",
          source,
          context,
          diagnostic,
          model: input.model,
          signal: input.signal,
        });
        source = extractRepairedWidget(repaired.response, language);
        replacements += 1;
        continue;
      }

      const published = publishInlineWidget(compiled);
      try {
        const capture = await this.captureWidget(
          input.sessionId,
          published,
          input.signal ?? new AbortController().signal,
        );
        diagnostic = [diagnostic, ...capture.diagnostics].join("\n").slice(0, 8_000);
        const reviewed = await this.runWidgetVisualReview({
          cwd: this.workspacePath,
          agentDir: this.agentDir,
          sessionDir: this.widgetSessionDir,
          source,
          context,
          diagnostic,
          pngBase64: capture.pngBase64,
          model: input.model,
          signal: input.signal,
        });
        if (reviewed.response.trim() === "ACCEPT_CURRENT")
          return { language, source, generationSessionId: generated.sessionId };
        if (replacements >= 2)
          throw new Error(
            "Widget visual review requested a third replacement; the two-replacement limit is exhausted",
          );
        source = extractRepairedWidget(reviewed.response, language);
        replacements += 1;
        diagnostic = "Visual reviewer supplied a replacement.";
      } catch (error) {
        if (input.signal?.aborted) throw new Error("Widget generation was cancelled");
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("two-replacement limit")) throw error;
        if (replacements >= 2) throw error;
        const repaired = await this.runWidgetRepair({
          cwd: this.workspacePath,
          agentDir: this.agentDir,
          sessionDir: this.widgetSessionDir,
          language,
          capability: "display",
          source,
          context,
          diagnostic: `Rendered preview failed: ${message}`.slice(0, 8_000),
          model: input.model,
          signal: input.signal,
        });
        source = extractRepairedWidget(repaired.response, language);
        replacements += 1;
      } finally {
        revokeInlineWidget(published.token);
      }
    }
  }
}
