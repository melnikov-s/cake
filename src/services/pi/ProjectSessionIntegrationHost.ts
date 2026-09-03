import { resolve } from "node:path";
import type { SourceLocation } from "../../ipc/source-location";
import type { ModelPreset, UtilityModel } from "../../ipc/session-contract";
import type { WorktreeLandingCoordinator } from "../../ipc/worktree-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type { VscodeActionResult } from "../vscode/VsCodeServer";
import {
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";
import type { CakeEvent, cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import type { PluginResourcesSnapshot } from "../plugins/PluginResources";
import { compileInlineWidget, extractRepairedWidget } from "../widgets/inline-widget-service";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  type InlineWidgetGenerationRequest,
} from "./runtime/sidecar-runtime";
import type { CakeRuntimeOptions, RuntimeUiRequest } from "./runtime/cake-runtime";

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

export type PiWorkspaceCommand =
  | ({ readonly type: "respond-ui" } & (typeof cakeRpcPayloadSchemas)["respond-ui"]["Type"])
  | ({
      readonly type: "respond-artifact";
    } & (typeof cakeRpcPayloadSchemas)["respond-artifact"]["Type"]);

interface PendingUi {
  readonly operationId: string;
  readonly settle: (value: string | undefined) => void;
}
interface PendingArtifact {
  readonly operationId: string;
  readonly record: ArtifactRecord;
  readonly artifactRequestId: string;
  readonly settle: (value: JsonValue | undefined) => void;
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
>;

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
  readonly pluginAgentSessionDir?: string;
  readonly emit: (event: CakeEvent) => void;
  readonly runWidgetGeneration?: typeof runInlineWidgetGeneration;
  readonly runWidgetRepair?: typeof runInlineWidgetRepair;
  readonly compileWidget?: typeof compileInlineWidget;
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
  readonly modelPresets?: () => {
    readonly presets: readonly Pick<ModelPreset, "id" | "name" | "modelId">[];
    readonly defaultPresetId?: string;
  };
  readonly worktreeLanding?: WorktreeLandingCoordinator;
  readonly fastMode?: (sessionId: string) => boolean;
  readonly setFastMode?: (sessionId: string, enabled: boolean) => Promise<void>;
  readonly sessionResolved?: (sessionId: string) => boolean;
  readonly setSessionResolved?: (sessionId: string, resolved: boolean) => Promise<void>;
  readonly pluginResources?: () => PluginResourcesSnapshot;
}

export class ProjectSessionIntegrationHost {
  readonly workspacePath: string;
  private readonly agentDir: string;
  private readonly widgetSessionDir: string;
  private readonly emitEvent: (event: CakeEvent) => void;
  private readonly runWidgetGeneration: typeof runInlineWidgetGeneration;
  private readonly runWidgetRepair: typeof runInlineWidgetRepair;
  private readonly compileWidget: typeof compileInlineWidget;
  private readonly artifactRepository: ArtifactRepositoryPort;
  private readonly reviewRepository: ReviewRepositoryPort;
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly pendingArtifacts = new Map<string, PendingArtifact>();
  private disposed = false;

  constructor(options: ProjectSessionIntegrationHostOptions) {
    this.workspacePath = options.workspacePath;
    this.agentDir = options.agentDir;
    this.widgetSessionDir =
      options.widgetSessionDir ?? resolve(options.sessionDir, "..", "widget-sessions");
    this.emitEvent = options.emit;
    this.runWidgetGeneration = options.runWidgetGeneration ?? runInlineWidgetGeneration;
    this.runWidgetRepair = options.runWidgetRepair ?? runInlineWidgetRepair;
    this.compileWidget = options.compileWidget ?? compileInlineWidget;
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

  dispatch(command: PiWorkspaceCommand) {
    if (this.disposed) throw new Error("The Pi workspace integrations have been disposed");
    if (command.type === "respond-ui") {
      const pending = this.pendingUi.get(command.uiRequestId);
      if (pending?.operationId === command.requestId)
        pending.settle(command.cancelled ? undefined : command.value);
      return;
    }
    const pending = this.pendingArtifacts.get(command.artifactRequestId);
    if (pending?.operationId === command.requestId)
      pending.settle(command.cancelled ? undefined : command.value);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingUi.values()) pending.settle(undefined);
    for (const pending of this.pendingArtifacts.values()) pending.settle(undefined);
    this.pendingUi.clear();
    this.pendingArtifacts.clear();
  }

  cancelPendingRequests() {
    for (const pending of this.pendingArtifacts.values()) pending.settle(undefined);
    this.pendingArtifacts.clear();
  }

  projectSessionRuntimeIntegrations(sessionId: string): ProjectSessionRuntimeIntegrations {
    const reviewContextPath = this.reviewRepository.reviewContextPath;
    return {
      requestUi: (request) => this.requestUi(request),
      emitExtensionUiIntent: (intent) =>
        this.emit({ type: "extension-ui-intent", sessionId, intent }),
      persistArtifact: (artifact) => this.persistArtifact(artifact, sessionId),
      requestArtifact: (record, signal) => this.requestArtifact(record, signal),
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

  private requestUi(request: RuntimeUiRequest) {
    const operationId = crypto.randomUUID();
    const uiRequestId = crypto.randomUUID();
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.pendingUi.delete(uiRequestId);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => settle(undefined);
      this.pendingUi.set(uiRequestId, { operationId, settle });
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.timeout) timeout = setTimeout(() => settle(undefined), request.timeout);
      this.emit({
        type: "ui-request",
        requestId: operationId,
        uiRequestId,
        kind: request.kind,
        title: request.title,
        message: request.message,
        placeholder: request.placeholder,
        initialValue: request.initialValue,
        multiline: request.multiline,
        options: request.options,
      });
    });
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

  private requestArtifact(record: ArtifactRecord, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(undefined);
    const operationId = crypto.randomUUID();
    const artifactRequestId = crypto.randomUUID();
    return new Promise<JsonValue | undefined>((resolve) => {
      let settled = false;
      const settle = (value: JsonValue | undefined) => {
        if (settled) return;
        settled = true;
        this.pendingArtifacts.delete(artifactRequestId);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => settle(undefined);
      this.pendingArtifacts.set(artifactRequestId, {
        operationId,
        record,
        artifactRequestId,
        settle,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "artifact-requested", requestId: operationId, artifactRequestId, record });
    });
  }

  private async generateInlineWidget(input: InlineWidgetGenerationRequest) {
    const generated = await this.runWidgetGeneration({
      cwd: this.workspacePath,
      agentDir: this.agentDir,
      sessionDir: this.widgetSessionDir,
      ...input,
    });
    const language = "react" as const;
    const generatedSource = extractRepairedWidget(generated.response, language);
    try {
      await this.compileWidget(language, generatedSource, "display");
      return { language, source: generatedSource, generationSessionId: generated.sessionId };
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      const repaired = await this.runWidgetRepair({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        sessionDir: this.widgetSessionDir,
        language,
        capability: "display",
        source: generatedSource,
        context: JSON.stringify({ brief: input.brief, data: input.data, fallback: input.fallback }),
        diagnostic,
        model: input.model,
        signal: input.signal,
      });
      const source = extractRepairedWidget(repaired.response, language);
      await this.compileWidget(language, source, "display");
      return { language, source, generationSessionId: generated.sessionId };
    }
  }
}
