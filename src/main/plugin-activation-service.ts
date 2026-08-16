import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { customizationProvenanceSchema, customizationStateSchema, type CustomizationState, type PluginDiagnostic } from "../plugin/plugin-contract";
import type { CakePaths } from "./cake-paths";
import type { CandidateBuild, PluginBuildService } from "./plugin-build-service";
import { AtomicFileWriter } from "./atomic-file-writer";
import { hasFileErrorCode } from "./file-errors";

function initialState(): CustomizationState {
  return customizationStateSchema.parse({ schemaVersion: 1, recoveryRequired: false, diagnostics: [], updatedAt: new Date().toISOString() });
}

export type StartupRenderer =
  | { kind: "factory" }
  | { kind: "custom"; path: string; revision: string };

export class PluginActivationService {
  private state = initialState();
  private readonly writer = new AtomicFileWriter();
  private readonly statePath: string;
  private attemptId: string | undefined;
  private request = "Rebuild Cake customization";
  private baseRevision: string | undefined;
  private preparing = false;
  private startupCandidateRevision: string | undefined;

  constructor(readonly paths: CakePaths, readonly builder: PluginBuildService) {
    this.statePath = join(paths.recovery, "customization-state.json");
  }

  async load() {
    await mkdir(this.paths.recovery, { recursive: true });
    try { this.state = customizationStateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8"))); }
    catch (error) {
      if (!hasFileErrorCode(error, "ENOENT") && !(error instanceof SyntaxError)) {
        this.state = { ...initialState(), recoveryRequired: true, diagnostics: [{ phase: "discovery", message: `Could not read customization activation state: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
    // A pending revision means the previous process never received the render
    // health handshake. Never import that candidate during recovery boot.
    if (this.state.pendingRevision) {
      this.state = { ...this.state, recoveryRequired: true, diagnostics: [...this.state.diagnostics, { phase: "render", message: `Customization ${this.state.pendingRevision} did not finish activation before Cake exited.` }], updatedAt: new Date().toISOString() };
      await this.persist();
    }
    if (!this.state.recoveryRequired && !this.state.pendingRevision && this.state.activeRevision && !await this.builder.isBuildCurrent(this.state.activeRevision)) {
      this.attemptId = crypto.randomUUID();
      this.request = "Rebuild customization for the current Cake renderer";
      this.baseRevision = this.state.sourceRevision;
      const candidate = await this.builder.buildCandidate();
      if (candidate.diagnostics.length) {
        this.state = { ...this.state, sourceRevision: candidate.sourceRevision, recoveryRequired: true, diagnostics: candidate.diagnostics, updatedAt: new Date().toISOString() };
        await this.record("rejected", candidate.revision, candidate.diagnostics);
      } else {
        this.startupCandidateRevision = candidate.revision;
        this.state = { ...this.state, sourceRevision: candidate.sourceRevision, pendingRevision: candidate.revision, recoveryRequired: true, diagnostics: [], updatedAt: new Date().toISOString() };
        await this.record("candidate", candidate.revision, []);
      }
      await this.persist();
    }
    return this.snapshot();
  }

  snapshot(): CustomizationState { return customizationStateSchema.parse(this.state); }

  buildPath(revision: string) { return join(this.paths.recovery, "builds", revision, "index.html"); }

  startupRenderer(): StartupRenderer {
    if (this.startupCandidateRevision && this.state.pendingRevision === this.startupCandidateRevision) {
      return { kind: "custom", revision: this.startupCandidateRevision, path: this.buildPath(this.startupCandidateRevision) };
    }
    if (this.state.recoveryRequired || this.state.pendingRevision || !this.state.activeRevision) return { kind: "factory" };
    return { kind: "custom", revision: this.state.activeRevision, path: this.buildPath(this.state.activeRevision) };
  }

  async prepare(expectedBaseRevision?: string, request = "Rebuild Cake customization", expectedSourceRevision?: string): Promise<CandidateBuild> {
    if (this.preparing) throw new Error("A customization candidate is already being built");
    if (this.state.pendingRevision) throw new Error(`Customization ${this.state.pendingRevision} is still awaiting its render health check`);
    this.preparing = true;
    try {
      if (expectedBaseRevision && this.state.sourceRevision !== expectedBaseRevision) {
        throw new Error(`Customization head changed: expected ${expectedBaseRevision}, found ${this.state.sourceRevision ?? "no revision"}`);
      }
      if (expectedSourceRevision) {
        const current = await this.builder.repository.inspect();
        if (current.revision !== expectedSourceRevision) throw new Error(`Customization source changed: expected ${expectedSourceRevision}, found ${current.revision}`);
      }
      this.attemptId = crypto.randomUUID();
      this.request = request;
      this.baseRevision = this.state.sourceRevision;
      const candidate = await this.builder.buildCandidate();
      if (candidate.diagnostics.length) {
        this.state = { ...this.state, sourceRevision: candidate.sourceRevision, diagnostics: candidate.diagnostics, updatedAt: new Date().toISOString() };
        await this.persist();
        await this.record("rejected", candidate.revision, candidate.diagnostics);
        return candidate;
      }
      this.state = { ...this.state, sourceRevision: candidate.sourceRevision, pendingRevision: candidate.revision, recoveryRequired: true, diagnostics: [], updatedAt: new Date().toISOString() };
      await this.persist();
      await this.record("candidate", candidate.revision, []);
      return candidate;
    } finally {
      this.preparing = false;
    }
  }

  async markHealthy(revision: string) {
    if (this.state.pendingRevision !== revision) throw new Error(`Customization ${revision} is not the pending activation`);
    const refreshedForCurrentRenderer = this.startupCandidateRevision === revision;
    this.state = {
      ...this.state,
      activeRevision: revision,
      rollbackRevision: refreshedForCurrentRenderer ? undefined : this.state.lastKnownGoodRevision,
      lastKnownGoodRevision: revision,
      pendingRevision: undefined,
      failedRevision: undefined,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date().toISOString()
    };
    await this.persist();
    this.startupCandidateRevision = undefined;
    await this.record("activated", revision, []);
  }

  async fail(revision: string | undefined, diagnostic: PluginDiagnostic) {
    this.startupCandidateRevision = undefined;
    this.state = { ...this.state, pendingRevision: undefined, failedRevision: revision, recoveryRequired: true, diagnostics: [...this.state.diagnostics, diagnostic], updatedAt: new Date().toISOString() };
    await this.persist();
    if (revision) await this.record("failed", revision, [diagnostic]);
  }

  async rollback() {
    const revision = this.state.failedRevision && this.state.failedRevision !== this.state.activeRevision
      ? this.state.lastKnownGoodRevision
      : this.state.rollbackRevision ?? this.state.lastKnownGoodRevision;
    this.state = {
      ...this.state,
      activeRevision: revision,
      lastKnownGoodRevision: revision,
      rollbackRevision: undefined,
      pendingRevision: undefined,
      failedRevision: undefined,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date().toISOString()
    };
    await this.persist();
    if (revision) await this.record("rolled-back", revision, []);
    return revision;
  }

  async useFactory() {
    this.state = { ...this.state, activeRevision: undefined, pendingRevision: undefined, failedRevision: undefined, recoveryRequired: false, diagnostics: [], updatedAt: new Date().toISOString() };
    await this.persist();
    const revision = this.state.sourceRevision;
    if (revision) await this.record("factory", revision, []);
  }

  private async persist() {
    await this.writer.write(this.statePath, `${JSON.stringify(customizationStateSchema.parse(this.state), null, 2)}\n`);
  }

  private async record(result: "rejected" | "candidate" | "activated" | "failed" | "rolled-back" | "factory", revision: string, diagnostics: PluginDiagnostic[]) {
    const record = customizationProvenanceSchema.parse({
      schemaVersion: 1,
      attemptId: this.attemptId ?? crypto.randomUUID(),
      request: this.request,
      baseRevision: this.baseRevision,
      resultingRevision: revision,
      result,
      diagnostics,
      recordedAt: new Date().toISOString()
    });
    const directory = join(this.paths.recovery, "history");
    await mkdir(directory, { recursive: true });
    const timestamp = record.recordedAt.replaceAll(":", "-");
    await this.writer.write(join(directory, `${timestamp}-${record.attemptId}-${result}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
}
