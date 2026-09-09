import { Store, batch, observable, snapshot } from "r-state-tree";
import type {
  ApplicationState,
  ChatConfiguration,
  ModelOption,
  ModelPreset,
} from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

interface ModelPresetProjection {
  readonly presets: readonly ModelPreset[];
  readonly defaultPresetId?: string;
}

const samePresetProjection = (left: ModelPresetProjection, right: ModelPresetProjection): boolean =>
  left.defaultPresetId === right.defaultPresetId &&
  left.presets.length === right.presets.length &&
  left.presets.every((preset, index) => {
    const candidate = right.presets[index];
    return (
      candidate !== undefined &&
      preset.id === candidate.id &&
      preset.name === candidate.name &&
      preset.provider === candidate.provider &&
      preset.modelId === candidate.modelId &&
      preset.thinkingLevel === candidate.thinkingLevel &&
      preset.fastMode === candidate.fastMode
    );
  });

export type ModelPresetResolutionStatus =
  | "available"
  | "unknown"
  | "unauthenticated"
  | "unavailable"
  | "unsupported-thinking-level"
  | "unsupported-fast-mode";

/**
 * Owns the settings view of the authoritative model-preset projection and its
 * serialized optimistic command queue. Revisions update the rollback baseline
 * during a command without replacing the optimistic view; a newer preset
 * revision wins over a stale command response when the command settles.
 */
export class ModelPresetSettingsStore extends Store {
  readonly presets: ModelPreset[] = observable([]);
  readonly catalogModels: ModelOption[] = observable([]);
  defaultPresetId: string | undefined;
  @snapshot lastUsedConfiguration: ChatConfiguration | undefined;
  loading = true;
  saving = false;
  sectionRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  private commandRevision = 0;
  private commandQueue: Promise<unknown> = Promise.resolve();
  private hydration: Promise<void> | undefined;
  private persistedPresets: ModelPreset[] = [];
  private persistedDefaultPresetId: string | undefined;
  private applicationRevision = -1;
  private presetProjectionRevision = -1;
  private readonly authoritativeIds = new Map<string, string>();

  get client() {
    return ClientContext.consume(this)!;
  }

  hydrate() {
    this.hydration ??= this.performHydration();
    return this.hydration;
  }

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.applicationRevision) return;
    this.applicationRevision = revision;
    const projection = {
      presets: state.modelPresets,
      defaultPresetId: state.defaultModelPresetId,
    };
    if (
      !samePresetProjection(projection, {
        presets: this.persistedPresets,
        defaultPresetId: this.persistedDefaultPresetId,
      })
    )
      this.presetProjectionRevision = revision;
    this.acceptAuthoritative(projection);
    if (!this.saving) this.restorePersisted();
  }

  get modelsByProvider() {
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of this.catalogModels) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }

  resolutionStatus(preset: ModelPreset): ModelPresetResolutionStatus {
    const model = this.catalogModels.find(
      (candidate) => candidate.provider === preset.provider && candidate.id === preset.modelId,
    );
    if (!model) return "unknown";
    if (!model.authenticated) return "unauthenticated";
    if (model.available === false) return "unavailable";
    if (!model.availableThinkingLevels.includes(preset.thinkingLevel))
      return "unsupported-thinking-level";
    if (preset.fastMode && !model.fastMode) return "unsupported-fast-mode";
    return "available";
  }

  get defaultConfiguration() {
    const preset = this.presets.find((candidate) => candidate.id === this.defaultPresetId);
    if (preset)
      return {
        provider: preset.provider,
        modelId: preset.modelId,
        thinkingLevel: preset.thinkingLevel,
        fastMode: preset.fastMode,
      } satisfies ChatConfiguration;
    return this.lastUsedConfiguration ? { ...this.lastUsedConfiguration } : undefined;
  }

  /** Records the configuration a chat is actually running with for the no-default fallback. */
  recordUsage(configuration: ChatConfiguration) {
    const current = this.lastUsedConfiguration;
    if (
      current &&
      current.provider === configuration.provider &&
      current.modelId === configuration.modelId &&
      current.thinkingLevel === configuration.thinkingLevel &&
      current.fastMode === configuration.fastMode
    )
      return;
    this.lastUsedConfiguration = { ...configuration };
  }

  requestSection() {
    this.sectionRequestRevision += 1;
  }

  createPreset(preset: Omit<ModelPreset, "id">) {
    const optimisticId = crypto.randomUUID();
    const revision = this.beginOptimistic(
      [...this.presets, { ...preset, id: optimisticId }],
      this.defaultPresetId,
    );
    return this.enqueue(revision, async () => {
      const knownIds = new Set(this.persistedPresets.map((candidate) => candidate.id));
      const state = await this.client.modelPresets.create(preset, {
        signal: this.signal,
      });
      const created = state.presets.find((candidate) => !knownIds.has(candidate.id));
      if (created) this.authoritativeIds.set(optimisticId, created.id);
      return state;
    });
  }

  updatePreset(preset: ModelPreset) {
    const revision = this.beginOptimistic(
      this.presets.map((current) => (current.id === preset.id ? { ...preset } : current)),
      this.defaultPresetId,
    );
    return this.enqueue(revision, () =>
      this.client.modelPresets.update(
        {
          ...preset,
          id: this.resolveAuthoritativeId(preset.id),
        },
        { signal: this.signal },
      ),
    );
  }

  duplicatePreset(id: string) {
    const source = this.presets.find((preset) => preset.id === id);
    if (!source) return Promise.resolve();
    return this.createPreset({ ...source, name: `${source.name} copy` });
  }

  reorderPreset(id: string, targetId: string) {
    const sourceIndex = this.presets.findIndex((preset) => preset.id === id);
    const targetIndex = this.presets.findIndex((preset) => preset.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return Promise.resolve();
    const reordered = [...this.presets];
    const [source] = reordered.splice(sourceIndex, 1);
    if (!source) return Promise.resolve();
    reordered.splice(targetIndex, 0, source);
    const revision = this.beginOptimistic(reordered, this.defaultPresetId);
    return this.enqueue(revision, () =>
      this.client.modelPresets.reorder(
        { ids: reordered.map((preset) => this.resolveAuthoritativeId(preset.id)) },
        { signal: this.signal },
      ),
    );
  }

  deletePreset(id: string) {
    const revision = this.beginOptimistic(
      this.presets.filter((preset) => preset.id !== id),
      this.defaultPresetId === id ? undefined : this.defaultPresetId,
    );
    return this.enqueue(revision, () =>
      this.client.modelPresets.remove(this.resolveAuthoritativeId(id), {
        signal: this.signal,
      }),
    );
  }

  setDefaultPreset(id: string | undefined) {
    const revision = this.beginOptimistic(this.presets, id);
    return this.enqueue(revision, () =>
      this.client.modelPresets.setDefault(
        id === undefined ? undefined : this.resolveAuthoritativeId(id),
        { signal: this.signal },
      ),
    );
  }

  private async performHydration() {
    try {
      const models = await this.client.models.list({ signal: this.signal });
      if (this.signal.aborted) return;
      this.catalogModels.splice(0, this.catalogModels.length, ...models);
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    } finally {
      if (!this.signal.aborted) this.loading = false;
    }
  }

  private beginOptimistic(presets: readonly ModelPreset[], defaultPresetId: string | undefined) {
    const revision = ++this.commandRevision;
    batch(() => {
      this.presets.splice(0, this.presets.length, ...presets.map((preset) => ({ ...preset })));
      this.defaultPresetId = defaultPresetId;
      this.saving = true;
      this.error = undefined;
      this.errorDetails = undefined;
    });
    return revision;
  }

  private enqueue(revision: number, command: () => Promise<ModelPresetProjection>) {
    const pending = this.commandQueue
      .catch(() => undefined)
      .then(async () => {
        const basePresetProjectionRevision = this.presetProjectionRevision;
        return { state: await command(), basePresetProjectionRevision };
      })
      .then(({ state, basePresetProjectionRevision }) => {
        if (this.signal.aborted) return;
        if (this.presetProjectionRevision === basePresetProjectionRevision)
          this.acceptAuthoritative(state);
        if (revision === this.commandRevision) this.restorePersisted();
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.commandRevision) return;
        this.restorePersisted();
        this.setError(error);
      })
      .finally(() => {
        if (!this.signal.aborted && revision === this.commandRevision) this.saving = false;
      });
    this.commandQueue = pending;
    return pending;
  }

  private acceptAuthoritative(state: ModelPresetProjection) {
    this.persistedPresets = state.presets.map((preset) => ({ ...preset }));
    this.persistedDefaultPresetId = state.defaultPresetId;
  }

  private resolveAuthoritativeId(id: string) {
    return this.authoritativeIds.get(id) ?? id;
  }

  private restorePersisted() {
    batch(() => {
      this.presets.splice(
        0,
        this.presets.length,
        ...this.persistedPresets.map((preset) => ({ ...preset })),
      );
      this.defaultPresetId = this.persistedDefaultPresetId;
    });
  }

  private setError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
}
